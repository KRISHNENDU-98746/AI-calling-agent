"""VideoSDK telephony worker for the existing rule-based appointment service."""

import asyncio
import audioop
import base64
import json
import logging
import os
import urllib.request
from typing import AsyncIterator, Optional, Union
from wave import Error as WaveError
import wave

import websockets
from dotenv import load_dotenv
from videosdk.agents import (
    Agent,
    AgentSession,
    ChatContext,
    ChatRole,
    JobContext,
    LLM,
    LLMResponse,
    Options,
    Pipeline,
    RoomOptions,
    SpeechData,
    SpeechEventType,
    STT,
    STTResponse,
    TTS,
    WorkerJob,
)

load_dotenv()
logging.basicConfig(level=logging.INFO)
LOGGER = logging.getLogger("doctor-videosdk-agent")

AGENT_ID = os.getenv("VIDEOSDK_AGENT_ID", "doctor-appointment-agent")
BACKEND_URL = os.getenv("BACKEND_URL", "https://doctor-34h2.onrender.com").rstrip("/")
INTERNAL_AGENT_SECRET = os.getenv("INTERNAL_AGENT_SECRET", "")
SARVAM_API_KEY = os.getenv("SARVAM_API_KEY", "")
SARVAM_LANGUAGE = os.getenv("SARVAM_STT_LANGUAGE", "auto")
SARVAM_MODE = os.getenv("SARVAM_STT_MODE", "codemix")
SARVAM_TTS_LANGUAGE = os.getenv("SARVAM_TTS_LANGUAGE", "en-IN")
SARVAM_TTS_SPEAKER = os.getenv("SARVAM_TTS_SPEAKER", "shubh")
SARVAM_TTS_MODEL = os.getenv("SARVAM_TTS_MODEL", "bulbul:v3")
SARVAM_STT_SAMPLE_RATE = 16000
ROOM_SAMPLE_RATE = 24000


def require_config() -> None:
    missing = [
        name
        for name, value in {
            "SARVAM_API_KEY": SARVAM_API_KEY,
            "INTERNAL_AGENT_SECRET": INTERNAL_AGENT_SECRET,
        }.items()
        if not value
    ]
    if missing:
        raise RuntimeError(f"Missing worker configuration: {', '.join(missing)}")


def _request_json(url: str, payload: dict, headers: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json", **headers}, method="POST"
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.loads(response.read().decode("utf-8"))


async def call_conversation_api(context: JobContext, text: str) -> str:
    room_id = context.room_options.room_id or "videosdk-call"
    metadata = context.metadata or {}
    payload = {
        "conversationId": f"videosdk:{room_id}",
        "text": text,
        "callerPhone": metadata.get("callerPhone") or metadata.get("from"),
        "callSid": metadata.get("callSid") or metadata.get("call_sid"),
    }
    result = await asyncio.to_thread(
        _request_json,
        f"{BACKEND_URL}/internal/conversation",
        payload,
        {"x-internal-agent-secret": INTERNAL_AGENT_SECRET},
    )
    response = result.get("response")
    if not isinstance(response, str) or not response:
        raise RuntimeError("Conversation API returned no response text")
    return response


class SarvamSTT(STT):
    """SDK STT adapter backed by Sarvam's documented realtime WebSocket."""

    def __init__(self) -> None:
        super().__init__(forward_interim_transcripts=False)
        self._socket = None
        self._recv_task = None

    async def _connect(self):
        language = SARVAM_LANGUAGE or "auto"
        params = (
            f"language_code={language}&model=saaras:v3-realtime&mode={SARVAM_MODE}"
            f"&stream_type=fast&endpointing=vad&encoding=linear16&sample_rate={SARVAM_STT_SAMPLE_RATE}"
            "&silence_duration_ms=700&threshold=0.3&min_speech_duration_ms=250"
        )
        self._socket = await websockets.connect(
            f"wss://api.sarvam.ai/speech-to-text-realtime/ws?{params}",
            additional_headers={"api-subscription-key": SARVAM_API_KEY},
        )

    @staticmethod
    def _room_to_sarvam(audio_frames: bytes) -> bytes:
        # VideoSDK Agents documents the default agent track as 24 kHz mono s16 PCM;
        # Sarvam realtime accepts mono linear16 at 8 or 16 kHz.
        converted, _ = audioop.ratecv(audio_frames, 2, 1, ROOM_SAMPLE_RATE, SARVAM_STT_SAMPLE_RATE, None)
        return converted

    async def stream_transcribe(self, audio_stream: AsyncIterator[bytes], **kwargs) -> AsyncIterator[STTResponse]:
        await self._connect()
        output = asyncio.Queue()
        finished = asyncio.Event()

        async def send_audio():
            try:
                async for chunk in audio_stream:
                    if self._socket:
                        await self._socket.send(json.dumps({"event": "audio_input", "audio": base64.b64encode(self._room_to_sarvam(chunk)).decode()}))
            finally:
                finished.set()

        async def receive_transcripts():
            try:
                async for raw in self._socket:
                    message = json.loads(raw)
                    if message.get("event") == "transcript.final":
                        text = message.get("text") or message.get("transcript") or ""
                        if text:
                            await output.put(STTResponse(
                                event_type=SpeechEventType.FINAL,
                                data=SpeechData(text=text, language=message.get("language")),
                            ))
            finally:
                finished.set()

        sender = asyncio.create_task(send_audio())
        receiver = asyncio.create_task(receive_transcripts())
        try:
            while not (finished.is_set() and output.empty()):
                try:
                    yield await asyncio.wait_for(output.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    if sender.done() and receiver.done():
                        break
        finally:
            sender.cancel()
            receiver.cancel()
            if self._socket:
                await self._socket.close()
                self._socket = None

    async def process_audio(self, audio_frames: bytes, language: Optional[str] = None, **kwargs) -> None:
        raise NotImplementedError("SarvamSTT uses stream_transcribe")


class SarvamTTS(TTS):
    """SDK TTS adapter that emits raw PCM matching the VideoSDK agent track."""

    def __init__(self) -> None:
        super().__init__(sample_rate=ROOM_SAMPLE_RATE, num_channels=1)
        self._interrupted = False

    async def synthesize(self, text: Union[AsyncIterator[str], str], voice_id=None, **kwargs) -> None:
        self._interrupted = False
        if not isinstance(text, str):
            text = "".join(chunk async for chunk in text if isinstance(chunk, str))
        payload = {
            "text": text,
            "language_code": SARVAM_TTS_LANGUAGE,
            "speaker": voice_id or SARVAM_TTS_SPEAKER,
            "model": SARVAM_TTS_MODEL,
            "pace": 1.0,
            "speech_sample_rate": ROOM_SAMPLE_RATE,
            "output_audio_codec": "wav",
        }
        response = await asyncio.to_thread(
            _request_json,
            "https://api.sarvam.ai/text-to-speech",
            payload,
            {"api-subscription-key": SARVAM_API_KEY},
        )
        audio = base64.b64decode(response["audios"][0])
        pcm = self._wav_to_pcm(audio)
        if self.audio_track and not self._interrupted:
            await self.audio_track.add_new_bytes(pcm)

    @staticmethod
    def _wav_to_pcm(audio: bytes) -> bytes:
        try:
            import io
            with wave.open(io.BytesIO(audio), "rb") as source:
                if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() != ROOM_SAMPLE_RATE:
                    raise WaveError("Unexpected Sarvam TTS WAV format")
                return source.readframes(source.getnframes())
        except (WaveError, EOFError) as error:
            raise RuntimeError("Sarvam TTS did not return 24 kHz mono PCM WAV") from error

    async def interrupt(self) -> None:
        self._interrupted = True
        if self.audio_track and hasattr(self.audio_track, "interrupt"):
            self.audio_track.interrupt()


class RuleBasedLLM(LLM):
    """VideoSDK pipeline adapter; response generation remains in Node's rule engine."""

    async def chat(self, messages: ChatContext, tools=None, conversational_graph=None, **kwargs):
        user_message = next((item for item in reversed(messages.messages()) if item.role == ChatRole.USER), None)
        if user_message is None:
            return
        content = user_message.content
        text = content if isinstance(content, str) else " ".join(str(item) for item in content)
        response = await call_conversation_api(self._job_context, text)
        yield LLMResponse(content=response, role=ChatRole.ASSISTANT)

    async def cancel_current_generation(self) -> None:
        return None


class AppointmentAgent(Agent):
    def __init__(self):
        super().__init__(
            instructions="Use the appointment conversation response supplied by the rule-based backend. Do not invent responses."
        )

    async def on_enter(self) -> None:
        await self.session.say("Hello, welcome to the clinic. I can help you book an appointment request. May I know your name?")


async def start_session(context: JobContext):
    agent = AppointmentAgent()
    stt = SarvamSTT()
    tts = SarvamTTS()
    llm = RuleBasedLLM()
    llm._job_context = context
    pipeline = Pipeline(stt=stt, llm=llm, tts=tts)
    session = AgentSession(agent=agent, pipeline=pipeline)
    await session.start(wait_for_participant=True, run_until_shutdown=True)


def make_context() -> JobContext:
    return JobContext(room_options=RoomOptions(
        playground=False,
        auto_end_session=True,
        session_timeout_seconds=None,
        no_participant_timeout_seconds=None,
    ))


def main() -> None:
    require_config()
    WorkerJob(
        entrypoint=start_session,
        jobctx=make_context,
        options=Options(
            agent_id=AGENT_ID,
            register=True,
            max_processes=int(os.getenv("VIDEOSDK_MAX_PROCESSES", "4")),
            host=os.getenv("VIDEOSDK_WORKER_HOST", "0.0.0.0"),
            port=int(os.getenv("VIDEOSDK_WORKER_PORT", "8081")),
        ),
    ).start()


if __name__ == "__main__":
    main()
