# VideoSDK telephony agent

This worker uses the official `videosdk-agents` Python SDK as a self-hosted registered agent. It does not implement SIP/RTP and does not contain an LLM. VideoSDK owns phone-to-room media; the worker uses Sarvam realtime STT and TTS and calls the existing Node rule engine.

## Install and run

Python 3.12+ is required by the current VideoSDK Agents documentation.

```powershell
cd videosdk-agent
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python agent.py
```

Set `VIDEOSDK_AUTH_TOKEN` to a VideoSDK token. The worker registers the stable self-hosted agent ID `doctor-appointment-agent` by default. Do not put secrets in this repository.

## Dashboard

1. In VideoSDK Dashboard, configure Telephony/SIP and add or select the existing trial number `+91 8031450273`.
2. Create a Routing Rule for that number.
3. Set Call Direction to `Inbound`.
4. Set the room to `Dynamic`.
5. Set dispatch/agent type to `Self-hosted` and Agent ID to `doctor-appointment-agent`.
6. Save the rule while `python agent.py` is running and registered.
7. Call the number and verify the greeting, then complete the rule-based flow.

The Agent ID field is not a WebSocket URL and must not contain the Render URL.

## Configuration

`INTERNAL_AGENT_SECRET` must exactly match the Node Render environment variable. Node must also have `SARVAM_API_KEY` and Firestore credentials configured for live calls. The worker must have outbound HTTPS access to Render, Sarvam, and VideoSDK.

The worker does not claim that a real phone call works until the dashboard, credentials, number, and live worker are configured and tested together.
