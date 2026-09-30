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
  const live = Boolean(config.agentEnabled && config.clinicOpen && config.doctorAvailable);
  document.querySelector('#agentStatus').innerHTML = live ? '<i></i> Live' : '<i style="background:#c58e6c"></i> Paused';
  document.querySelector('#callToggle').classList.toggle('is-on', live);
  document.querySelector('.toggle-label').innerHTML = live ? '<i class="pulse"></i> Accepting calls' : '<i class="pulse" style="background:#c58e6c;box-shadow:0 0 0 3px #f4e6dc"></i> Calls paused';
  const doctor = document.querySelector('.doctor-line strong'); if (doctor) doctor.textContent = config.doctorName || 'Dr. Anik Rahman';
  const specialty = document.querySelector('.doctor-line span:not(.available-badge)'); if (specialty) specialty.textContent = config.specialty || 'General physician';
  const available = document.querySelector('.available-badge'); if (available) available.innerHTML = live ? '<i></i> Available today' : '<i style="background:#c58e6c"></i> Not available';
  const hours = document.querySelector('.hours-summary'); if (hours && config.hours) hours.innerHTML = `<span><b>${config.hours.start}</b> Start</span><span><b>${config.hours.end}</b> End</span><span><b>${config.appointmentDurationMinutes} min</b> per visit</span>`;
  const assistant = document.querySelector('.agent-copy strong'); if (assistant) assistant.textContent = `${config.doctorName || 'Doctor'}’s assistant`;
}
let currentConfig = null;
async function loadDashboard() {
  try { const data = await api('/admin/dashboard'); currentConfig = data.config; applyConfig(data.config); renderAppointments(data.appointments || []); renderPatients(data.appointments || []); const stat = document.querySelector('.accent-card strong'); if (stat) stat.textContent = String(data.stats?.todayAppointments || 0).padStart(2, '0'); }
  catch (error) { renderAppointments([], true); renderPatients([], true); showToast('Demo view active — connect the backend to load live data'); }
}
async function saveConfig(update, successMessage) { try { const data = await api('/admin/config', { method: 'PATCH', body: JSON.stringify(update) }); currentConfig = data.config; applyConfig(data.config); showToast(successMessage); } catch (error) { showToast('Could not save settings. Check the backend connection.'); } }

document.querySelector('#callToggle').addEventListener('click', () => { const next = !document.querySelector('#callToggle').classList.contains('is-on'); saveConfig({ agentEnabled: next, clinicOpen: next }, next ? 'AI agent is now accepting calls' : 'AI agent has been paused'); });
document.querySelector('#editAgent').addEventListener('click', () => {
  const greeting = prompt('Opening line for the agent:', currentConfig?.agentGreeting || 'আমি S.N. Tripathi-র clinic থেকে বলছি। আমি আপনাকে appointment লিখতে সাহায্য করব। আপনার নাম বলবেন?');
  if (greeting !== null) saveConfig({ agentGreeting: greeting }, 'Agent greeting updated');
});
document.querySelector('#editSchedule').addEventListener('click', () => { const open = confirm('Press OK to mark the doctor available today. Press Cancel to mark unavailable.'); saveConfig({ doctorAvailable: open }, open ? 'Doctor marked available' : 'Doctor marked unavailable'); });
document.querySelector('#newAppointment').addEventListener('click', () => showToast('New appointments are created by callers through the Twilio agent'));
document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', (event) => { document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.remove('active')); event.currentTarget.classList.add('active'); }));
loadDashboard();
