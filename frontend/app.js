const API_BASE = 'https://doctor-34h2.onrender.com';
const API_KEY = localStorage.getItem('careflow_admin_api_key') || '';
const demoAppointments = [
  { time: '09:30', period: 'AM', name: 'Nusrat Jahan', type: 'Follow-up visit', initials: 'NJ', status: 'Checked in' },
  { time: '10:15', period: 'AM', name: 'Tanvir Ahmed', type: 'General consultation', initials: 'TA', status: 'Waiting', statusClass: 'wait' },
  { time: '11:00', period: 'AM', name: 'Maliha Chowdhury', type: 'Follow-up visit', initials: 'MC', status: 'Confirmed' },
];

const toast = document.querySelector('#toast'); let toastTimer;
function showToast(message) { toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2800); }
function initials(name = '') { return name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'PT'; }
function apiHeaders() { return { 'Content-Type': 'application/json', ...(API_KEY ? { 'x-admin-api-key': API_KEY } : {}) }; }
async function api(path, options = {}) { const response = await fetch(`${API_BASE}${path}`, { ...options, headers: { ...apiHeaders(), ...(options.headers || {}) } }); if (!response.ok) throw new Error(`API ${response.status}`); return response.json(); }
function appointmentTime(value = '') { const match = String(value).match(/(\d{1,2}):(\d{2})/); if (!match) return { time: value || '--:--', period: '' }; const hour = Number(match[1]); return { time: `${String(hour > 12 ? hour - 12 : hour).padStart(2, '0')}:${match[2]}`, period: hour >= 12 ? 'PM' : 'AM' }; }
function isWithinHours(config) { const toMinutes = (value) => { const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/); return match ? Number(match[1]) * 60 + Number(match[2]) : null; }; const start = toMinutes(config?.hours?.start); const end = toMinutes(config?.hours?.end); if (start === null || end === null) return true; const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()); const now = Number(parts.find((part) => part.type === 'hour')?.value || 0) * 60 + Number(parts.find((part) => part.type === 'minute')?.value || 0); return start <= end ? now >= start && now < end : now >= start || now < end; }
function indiaMinutes() { const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()); return Number(parts.find((part) => part.type === 'hour')?.value || 0) * 60 + Number(parts.find((part) => part.type === 'minute')?.value || 0); }
function clockMinutes(value) { const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/); return match ? Number(match[1]) * 60 + Number(match[2]) : null; }
function scheduleClock(value) { const minutes = clockMinutes(value); if (minutes === null) return value || '--:--'; const h = Math.floor(minutes / 60); return `${String(h || 12).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; }
function schedulePeriod(minutes) { if (minutes < 12 * 60) return 'Morning'; if (minutes < 17 * 60) return 'Afternoon'; return 'Evening'; }
function updateScheduleVisual(config) {
  const start = clockMinutes(config?.hours?.start); const end = clockMinutes(config?.hours?.end);
  const timeRow = document.querySelector('.schedule-track .time-row'); const slotRow = document.querySelector('.schedule-track .slot-row'); const fill = document.querySelector('.schedule-track .track-fill');
  if (start === null || end === null || !timeRow || !slotRow || !fill) return;
  const midpoint = start + ((end >= start ? end : end + 1440) - start) / 2;
  const points = [start, midpoint, end].map((value) => value % 1440);
  timeRow.innerHTML = points.map(scheduleClock).map((label) => `<span>${label}</span>`).join('');
  slotRow.innerHTML = points.map((value) => `<span>${schedulePeriod(value)}</span>`).join('');
  const now = indiaMinutes(); const duration = end >= start ? end - start : end + 1440 - start; let elapsed = now - start; if (elapsed < 0 && end < start) elapsed += 1440;
  const progress = Math.max(0, Math.min(100, duration ? (elapsed / duration) * 100 : 0)); fill.style.width = `${progress}%`; fill.setAttribute('aria-label', `Current India time position: ${scheduleClock(now)}`);
}
function renderAppointments(items, demoIfEmpty = false) {
  const source = items.length ? items.slice(0, 5) : (demoIfEmpty ? demoAppointments : []);
  if (!source.length) { document.querySelector('#appointmentList').innerHTML = '<div class="empty-state">No appointments yet. New requests will appear here.</div>'; return; }
  document.querySelector('#appointmentList').innerHTML = source.map((item) => { const at = appointmentTime(item.preferredTime || item.time); const name = item.patientName || item.name; return `<div class="appointment"><span class="appt-time">${at.time}<br>${at.period}</span><div class="person"><span class="patient-avatar">${initials(name)}</span><div><strong>${name}</strong><span>${item.type || 'Appointment request'}</span></div></div><span class="pill ${item.statusClass || ''}">${item.status || 'Requested'}</span></div>`; }).join('');
}
function renderPatients(items, demoIfEmpty = false) {
  const source = items.length ? items.slice(0, 6) : (demoIfEmpty ? demoAppointments : []);
  if (!source.length) { document.querySelector('#patientRows').innerHTML = '<div class="empty-state">No patient records yet.</div>'; return; }
  document.querySelector('#patientRows').innerHTML = source.map((item) => { const name = item.patientName || item.name; const at = appointmentTime(item.preferredTime || item.time); return `<div class="table-row"><div class="person"><span class="patient-avatar">${initials(name)}</span><strong>${name}</strong></div><span class="token">${item.token || '—'}</span><span class="row-time">${at.time} ${at.period}</span><span class="pill ${item.statusClass || ''}">${item.status || 'Requested'}</span></div>`; }).join('');
}
function applyConfig(config) {
  if (!config) return;
  const live = Boolean(config.testMode || (config.agentEnabled && config.clinicOpen && config.doctorAvailable && isWithinHours(config)));
  document.querySelector('#agentStatus').innerHTML = live ? '<i></i> Live' : '<i style="background:#c58e6c"></i> Paused';
  document.querySelector('#callToggle').classList.toggle('is-on', live);
  const testModeButton = document.querySelector('#testModeToggle');
  if (testModeButton) {
    testModeButton.textContent = `Test mode: ${config.testMode ? 'On' : 'Off'}`;
    testModeButton.classList.toggle('selected', Boolean(config.testMode));
  }
  document.querySelector('.toggle-label').innerHTML = live ? '<i class="pulse"></i> Accepting calls' : '<i class="pulse" style="background:#c58e6c;box-shadow:0 0 0 3px #f4e6dc"></i> Calls paused';
  const doctor = document.querySelector('.doctor-line strong'); if (doctor) doctor.textContent = config.doctorName || 'S. N. Tripathi';
  const specialty = document.querySelector('.doctor-line span:not(.available-badge)'); if (specialty) specialty.textContent = config.specialty || 'General physician';
  const available = document.querySelector('.available-badge'); if (available) available.innerHTML = live ? '<i></i> Available today' : '<i style="background:#c58e6c"></i> Not available';
  const hours = document.querySelector('.hours-summary'); if (hours && config.hours) hours.innerHTML = `<span><b>${config.hours.start}</b> Start</span><span><b>${config.hours.end}</b> End</span><span><b>${config.appointmentDurationMinutes} min</b> per visit</span>`;
  updateScheduleVisual(config);
  const assistant = document.querySelector('.agent-copy strong'); if (assistant) assistant.textContent = `${config.doctorName || 'Doctor'}’s assistant`;
}
let currentConfig = null;
async function loadDashboard() {
  try { const data = await api('/admin/dashboard'); currentConfig = data.config; applyConfig(data.config); renderAppointments(data.appointments || []); renderPatients(data.appointments || []); const stat = document.querySelector('.accent-card strong'); if (stat) stat.textContent = String(data.stats?.todayAppointments || 0).padStart(2, '0'); const served = Number(data.stats?.patientsServed || 0); const servedStat = document.querySelector('#patientsServedStat'); if (servedStat) servedStat.textContent = String(served).padStart(2, '0'); const avgWait = data.appointments?.length ? 18 : 0; const waitStat = document.querySelector('#avgWaitStat'); if (waitStat) waitStat.textContent = String(avgWait); if (!served) document.querySelector('#patientsServedNote').textContent = 'No patients yet'; if (!avgWait) document.querySelector('#avgWaitNote').textContent = 'No waiting patients'; }
  catch (error) { renderAppointments([], true); renderPatients([], true); showToast('Demo view active — connect the backend to load live data'); }
}
async function saveConfig(update, successMessage) { try { const data = await api('/admin/config', { method: 'PATCH', body: JSON.stringify(update) }); currentConfig = data.config; applyConfig(data.config); showToast(successMessage); } catch (error) { showToast('Could not save settings. Check the backend connection.'); } }

document.querySelector('#callToggle').addEventListener('click', () => { const next = !document.querySelector('#callToggle').classList.contains('is-on'); saveConfig({ agentEnabled: next, clinicOpen: next }, next ? 'AI agent is now accepting calls' : 'AI agent has been paused'); });
document.querySelector('#testModeToggle').addEventListener('click', () => { const next = !Boolean(currentConfig?.testMode); saveConfig({ testMode: next }, next ? 'Test mode is now ON' : 'Test mode is now OFF'); });
const agentModal = document.querySelector('#agentModal');
function openAgentModal() { agentModal.classList.add('open'); agentModal.setAttribute('aria-hidden', 'false'); }
function closeAgentModal() { agentModal.classList.remove('open'); agentModal.setAttribute('aria-hidden', 'true'); }
document.querySelector('#editAgent').addEventListener('click', openAgentModal);
document.querySelector('#closeAgentModal').addEventListener('click', closeAgentModal);
document.querySelector('#cancelAgentModal').addEventListener('click', closeAgentModal);
document.querySelectorAll('.mcq-options').forEach((group) => group.addEventListener('click', (event) => { const option = event.target.closest('button'); if (!option) return; group.querySelectorAll('button').forEach((item) => item.classList.remove('selected')); option.classList.add('selected'); }));
document.querySelector('#saveAgentModal').addEventListener('click', () => { const greeting = document.querySelector('[data-choice="greeting"] .selected')?.dataset.value || 'standard'; const greetingText = greeting === 'short' ? 'নমস্কার, appointment নিতে call করেছেন? আপনার নাম বলবেন?' : 'আমি S.N. Tripathi-র clinic থেকে বলছি। আমি আপনাকে appointment লিখতে সাহায্য করব। আপনার নাম বলবেন?'; const closedBehavior = document.querySelector('[data-choice="closed"] .selected')?.dataset.value || 'polite'; const replyStyle = document.querySelector('[data-choice="style"] .selected')?.dataset.value || 'short'; saveConfig({ agentGreeting: greetingText, closedBehavior, replyStyle }, 'Agent options updated'); closeAgentModal(); });
agentModal.addEventListener('click', (event) => { if (event.target === agentModal) closeAgentModal(); });
document.querySelector('#editSchedule').addEventListener('click', () => { const open = confirm('Press OK to mark the doctor available today. Press Cancel to mark unavailable.'); saveConfig({ doctorAvailable: open }, open ? 'Doctor marked available' : 'Doctor marked unavailable'); });
document.querySelector('#newAppointment').addEventListener('click', () => showToast('New appointments are created by callers through the Twilio agent'));
document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', (event) => { document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.remove('active')); event.currentTarget.classList.add('active'); }));
loadDashboard();
setInterval(() => { if (currentConfig) applyConfig(currentConfig); }, 60 * 1000);
