const element = (id) => document.getElementById(id);
const state = { session: null, conversation: null, epoch: 0, poll: null, sending: false, handoffBusy: false, signature: "", health: null, healthAt: 0, pollError: false, panel: "conversation", panelRequest: 0, controlBusy: false, deletionIntent: null, auth: null, capabilities: null, channelLink: null, supportClaim: null, staffPoll: null, staffPolling: false, staffPending: null };
const pendingCommands = new Map();
const provenanceLabels = new Map([["plause-memory", "Memory control"], ["plause-reminder-control", "Reminder control"], ["plause-reminder", "Reminder"], ["plause-actions", "Action control"], ["plause-research", "Research"], ["plause-status", "Request status"], ["plause-google-calendar", "Google Calendar"], ["plause-human", "Human support"]]);
const errorMessages = {
  invalid_invitation: "That development invitation is not valid. Check the invitation for this account.",
  sign_in_required: "Sign in again to continue.",
  run_local_setup: "Run npm run setup before starting the local server.",
  invalid_request: "Check the request fields and try again.",
  local_preview_only: "This prototype is available on the local development server only.",
  internal_error: "The server could not complete the request. Please try again.",
  handoff_unavailable: "Support mode cannot be changed for this conversation.",
  operator_resume_required: "An authorized staff member must resume the agent.",
  conversation_not_found: "This conversation is unavailable for your account.",
  model_not_configured: "The model is not configured for this service. Try again after it is configured.",
  model_budget_exceeded: "This account or service has reached its configured model budget.",
  model_unavailable: "The model is unavailable. Your conversation remains saved.",
  reauthentication_required: "Account confirmation failed. Confirm this account again before continuing.",
  deletion_confirmation_required: "Type DELETE MY PLAUSE ACCOUNT exactly to prepare deletion.",
  deletion_intent_invalid: "The deletion confirmation expired or was already used. Prepare a new review.",
  google_revocation_unresolved: "Local Google access is removed, but provider revocation remains unresolved. Reconnection requires operator/provider reconciliation.",
  identity_reauthentication_required: "Confirm your account again before continuing. Use the account confirmation controls below.",
  identity_disabled: "Google sign-in is not configured for this service.",
  operator_role_required: "This account does not have a staff role.",
  operator_access_changed: "Staff access changed. Confirm your account again and refresh capabilities.",
  support_claim_unavailable: "This claim expired or belongs to another staff member. Refresh the support inbox.",
  support_access_changed: "Support access changed while loading. No private text was returned. Refresh the inbox.",
  support_reply_conflict: "This reply identifier was already used for different text. Refresh and compose a new reply.",
  support_provider_control_unavailable: "The messaging provider owns this conversation or its ownership is unknown. Use the configured provider staff workspace; Plause cannot claim, reply, or resume the agent until provider control returns.",
  restore_locked: "Service maintenance is in progress. Reads and changes will become available after restore reconciliation.",
};

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof data?.error === "string" ? data.error : typeof data?.message === "string" ? data.message : null;
    throw new ApiError(errorMessages[detail] || detail?.slice(0, 250) || `The request could not be completed (${response.status}).`, response.status);
  }
  return data;
}

function feedback(message = "") {
  element("feedback").textContent = message;
  element("feedback").hidden = !message;
}

function report(error, fallback) {
  feedback(error instanceof ApiError ? error.message : fallback);
}

function serverStatus(text, connected) {
  const dot = document.createElement("span");
  dot.className = `status-dot ${connected ? "connected" : "unavailable"}`;
  dot.setAttribute("aria-hidden", "true");
  element("server-status").replaceChildren(dot, document.createTextNode(text));
}

async function loadHealth() {
  state.healthAt = Date.now();
  try {
    state.health = await api("/health");
    serverStatus("Server connected", true);
    element("environment-value").textContent = state.health.environment || "Unknown";
    element("model-value").textContent = state.health.model === "mock" ? "Mock model" : state.health.model === "openai" ? state.health.modelReady ? "Cloud AI configured" : "Cloud AI not ready" : "Unavailable";
    element("messaging-value").textContent = state.health.messaging === "mock" ? "Mock channel" : state.health.messaging || "Unknown";
    element("research-value").textContent = state.health.research?.ready ? "Search configured" : "Search disabled";
    element("apple-badge").textContent = state.health.apple?.enabled && state.health.apple?.webhookConfigured && state.health.apple?.transportConfigured ? "Apple provider configured" : "Apple not connected";
    renderModelState();
  } catch {
    state.health = null;
    serverStatus("Server unavailable", false);
    for (const id of ["environment-value", "model-value", "messaging-value", "research-value"]) element(id).textContent = "Unavailable";
    element("apple-badge").textContent = "Apple status unavailable";
    renderModelState();
  }
}

function renderModelState() {
  const health = state.health;
  const local = health?.environment === "local";
  element("surface-label").textContent = local ? "Development console" : "Your account";
  element("signin-kicker").textContent = local ? "Local preview" : "Sign in to Plause";
  const hosted = health?.model === "openai";
  const mock = health?.model === "mock";
  const ready = health?.modelReady === true;
  const appleConfigured = health?.apple?.enabled && health?.apple?.webhookConfigured && health?.apple?.transportConfigured;
  const appleNote = appleConfigured ? "Apple provider is configured; live delivery acceptance is unverified." : "Apple Messages is not connected.";
  const readiness = typeof health?.readinessError === "string" ? ` ${health.readinessError.slice(0, 180).replaceAll("_", " ")}.` : "";
  element("development-note").textContent = mock
    ? `This console uses a deterministic mock model. ${appleNote}`
    : hosted && ready
      ? `Cloud AI is configured. Messages, recent context, and enabled saved facts are sent to OpenAI. ${appleNote}`
      : hosted
        ? `Cloud AI is selected but is not ready.${readiness} Configure it from the terminal. ${appleNote}`
        : `Model configuration is unavailable. ${appleNote}`;
  element("channel-description").textContent = hosted && ready
    ? `Conversation console with hosted model requests. Message content, recent context, and enabled saved facts are sent to OpenAI. ${appleNote}`
    : `Development conversation console. ${appleNote}`;
  element("composer-caption").textContent = `${mock ? "Mock model · Simulated responses" : hosted && ready ? "Cloud AI configured · Sends context to OpenAI" : hosted ? "Cloud AI not ready · Configure in terminal" : "Model status unavailable"} · ${appleConfigured ? "Apple provider configured" : "Apple not connected"} · Enter to send`;
  if (state.conversation) renderConversation(state.conversation);
}

function clearSession() {
  state.epoch += 1;
  clearInterval(state.poll);
  state.poll = null;
  state.session = null;
  state.conversation = null;
  state.signature = "";
  state.sending = false;
  state.handoffBusy = false;
  state.pollError = false;
  state.panel = "conversation";
  state.panelRequest += 1;
  state.controlBusy = false;
  state.deletionIntent = null;
  state.channelLink = null;
  state.capabilities = null;
  state.supportClaim = null;
  state.staffPending = null;
  clearInterval(state.staffPoll); state.staffPoll = null;
  element("staff-navigation").hidden = true;
  element("signin-link").replaceChildren();
  pendingCommands.clear();
  element("control-body").replaceChildren();
  element("control-body").inert = false;
  element("control-body").removeAttribute("aria-busy");
  panelStatus();
  element("control-panel").hidden = true;
  element("conversation-panel").hidden = false;
  for (const control of document.querySelectorAll(".control-nav [data-panel]")) {
    if (control.dataset.panel === "conversation") control.setAttribute("aria-current", "page"); else control.removeAttribute("aria-current");
  }
  pendingSend = null;
  element("messages").replaceChildren();
  element("message-input").value = "";
  element("login-view").hidden = false;
  element("conversation-view").hidden = true;
  element("send-button").disabled = false;
  element("logout-button").disabled = false;
  element("logout-button").hidden = true;
}

async function openSession(session) {
  state.epoch += 1;
  const epoch = state.epoch;
  state.session = session;
  state.signature = "";
  element("account-name").textContent = session.user.displayName || "Your conversation";
  element("login-view").hidden = true;
  element("conversation-view").hidden = false;
  element("logout-button").hidden = false;
  element("invite-token").value = "";
  feedback();
  void loadHealth();
  void loadCapabilities();
  clearInterval(state.poll);
  await refreshConversation();
  if (epoch === state.epoch && state.session) state.poll = setInterval(() => { void refreshConversation(); }, 2000);
  if (epoch === state.epoch && state.session && messagesEntryContext(location.search)) await showPanel("account");
}

function messagesEntryContext(search) {
  const values = new URLSearchParams(search).getAll("onboarding");
  return values.length === 1 && values[0] === "messages";
}

async function loadAuth() {
  element("messages-onboarding-hint").hidden = !messagesEntryContext(location.search);
  try {
    state.auth = await api("/api/auth/status");
    const local = state.auth.invitationLoginAllowed === true;
    element("login-form").hidden = !local;
    element("invitation-hint").hidden = !local;
    element("google-signin").disabled = state.auth.configured !== true;
    element("signin-description").textContent = local ? "Use a locally generated invitation for a fictional test account. Google sign-in is available only when configured." : "Sign in with your Google account. Account creation depends on this service's signup setting.";
    element("signin-status").textContent = state.auth.configured ? "Google confirms your identity. Calendar access is a separate permission." : "Google sign-in is not configured. No provider sign-in has started.";
  } catch {
    state.auth = null; element("google-signin").disabled = true;
    element("login-form").hidden = true; element("invitation-hint").hidden = true;
    element("signin-status").textContent = "Sign-in configuration is unavailable. Reload after the service recovers.";
  }
}
async function loadCapabilities() {
  const epoch = state.epoch;
  try {
    const capabilities = await api("/api/operator/capabilities");
    if (epoch !== state.epoch || !state.session) return;
    state.capabilities = capabilities;
    element("staff-navigation").hidden = capabilities.canSupport !== true;
  } catch { if (epoch === state.epoch) { state.capabilities = null; element("staff-navigation").hidden = true; } }
}
async function loadCoverage() {
  try {
    const coverage = await api("/api/support/coverage");
    element("signin-support").textContent = coverage.configured
      ? `Human support: ${coverage.contact}. Coverage: ${coverage.hours} (${coverage.timeZone}). Availability is not confirmed by configuration.`
      : "Human support coverage is not configured. A reply time is not promised.";
    element("support-coverage").textContent = coverage.configured
      ? `Support coverage: ${coverage.hours} (${coverage.timeZone}). ${coverage.contact}. Requesting support pauses automated replies; staff availability is not confirmed by configuration.`
      : "Requesting support pauses automated replies. Support coverage is not configured; a reply time is not promised.";
  } catch {
    element("support-coverage").textContent = "Requesting support pauses automated replies. Support coverage is currently unavailable.";
    element("signin-support").textContent = "Human support contact details are currently unavailable.";
  }
}
async function startIdentity(intent, destination) {
  const epoch = state.epoch;
  const response = await api("/api/auth/google/start", { method: "POST", body: JSON.stringify({ intent }) });
  if (epoch !== state.epoch || !destination.isConnected) return;
  const link = googleAuthorizationLink(response.authorizationUrl);
  link.textContent = intent === "reauth" ? "Confirm account with Google" : "Continue to Google sign-in";
  link.target = "_self";
  destination.replaceChildren(dom("p", "control-inline-note", `The sign-in link expires ${readableDate(response.expiresAt)}. Opening it starts account confirmation; it does not grant Calendar access.`), link);
}
element("google-signin").addEventListener("click", async () => {
  const control = element("google-signin"); control.disabled = true; feedback();
  try { await startIdentity("signin", element("signin-link")); }
  catch (error) { report(error, "Sign-in could not be prepared. Please try again."); control.disabled = state.auth?.configured !== true; }
});

function messageTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function handoffControls(health, mode, busy = false) {
  const local = health?.environment === "local";
  const showResume = local && mode === "human";
  return {
    showResume,
    resumeDisabled: !showResume || busy,
    notice: local ? "You can resume the agent in this local preview."
      : ["staging", "production"].includes(health?.environment)
        ? "An authorized staff member must resume the agent."
        : "Resume is unavailable until the service environment is confirmed.",
  };
}

function renderHandoffControls(mode) {
  const controls = handoffControls(state.health, mode, state.handoffBusy);
  element("handoff-banner").hidden = mode !== "human";
  element("support-button").disabled = mode === "human" || state.handoffBusy;
  element("return-button").hidden = !controls.showResume;
  element("return-button").disabled = controls.resumeDisabled;
  element("handoff-resume-note").textContent = controls.notice;
}

function renderConversation(conversation) {
  state.conversation = conversation;
  const human = conversation.mode === "human";
  const hosted = state.health?.model === "openai";
  const mock = state.health?.model === "mock";
  element("mode-badge").textContent = human ? "Support mode" : hosted ? state.health.modelReady ? "Cloud AI configured" : "Cloud AI not ready" : mock ? "Mock model" : "Model unavailable";
  element("mode-badge").className = `badge ${human ? "badge-human" : "badge-active"}`;
  renderHandoffControls(conversation.mode);
  element("conversation-status").textContent = human ? "Automated replies paused" : `${hosted ? "Hosted model" : mock ? "Mock conversation" : "Local conversation"}${conversation.status ? ` · ${String(conversation.status).replaceAll("_", " ")}` : ""}`;
  element("message-input").placeholder = human ? "Leave a message in support mode…" : "Message Plause…";
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const signature = JSON.stringify(messages);
  element("empty-state").hidden = messages.length > 0;
  if (signature === state.signature) return;
  const scroll = element("message-scroll");
  const wasNearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  const firstLoad = !state.signature;
  state.signature = signature;
  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    const own = message.role === "user";
    const system = message.role === "system";
    const item = document.createElement("li");
    item.className = `message${own ? " message-user" : ""}${system ? " message-system" : ""}`;
    const label = document.createElement("span");
    label.className = "message-label";
    const model = typeof message.model === "string" ? message.model : null;
    // Historical replies need their own provenance; a settings change cannot relabel them.
    const origin = provenanceLabels.get(model)
      || (model === "mock" ? "Mock model" : model ? `Cloud AI · ${model.slice(0, 80)}` : "Model not recorded");
    label.textContent = own ? "You" : system ? "Conversation update" : message.role === "human" || message.role === "operator" ? "Support" : `Plause · ${origin}`;
    const body = document.createElement("p");
    body.className = "message-text";
    body.textContent = String(message.text ?? "");
    const meta = document.createElement("span");
    meta.className = "message-meta";
    const status = message.status ? String(message.status).replaceAll("_", " ") : "";
    meta.textContent = [messageTime(message.createdAt), status].filter(Boolean).join(" · ");
    item.append(label, body, meta);
    fragment.append(item);
  }
  element("messages").replaceChildren(fragment);
  if (wasNearBottom || firstLoad) scroll.scrollTop = scroll.scrollHeight;
}

let refreshing = false;
async function refreshConversation() {
  if (!state.session || refreshing) return;
  if (Date.now() - state.healthAt > 15_000) void loadHealth();
  refreshing = true;
  const epoch = state.epoch;
  try {
    const conversation = await api(`/api/conversations/${encodeURIComponent(state.session.conversationId)}`);
    if (epoch !== state.epoch) return;
    renderConversation(conversation);
    const displayed = conversation.messages.filter((message) => message.role === "assistant" && message.status === "sent").map((message) => message.id);
    if (displayed.length) void api(`/api/conversations/${encodeURIComponent(conversation.id)}/receipts`, { method: "POST", body: JSON.stringify({ messageIds: displayed }) }).catch(() => {});
    serverStatus("Server connected", true);
    if (state.pollError) { feedback(); state.pollError = false; }
  } catch (error) {
    if (epoch !== state.epoch) return;
    if (error.status === 401) {
      clearSession();
      feedback("Your session expired. Sign in again to continue.");
      return;
    }
    state.pollError = true;
    serverStatus("Conversation connection interrupted", false);
    report(error, "The conversation could not be refreshed. Retrying automatically.");
    element("conversation-status").textContent = "Connection interrupted · retrying";
  } finally { refreshing = false; }
}

element("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = element("login-button");
  if (button.disabled) return;
  button.disabled = true;
  feedback();
  const inviteToken = element("invite-token").value.trim();
  element("invite-token").value = "";
  try {
    const session = await api("/api/session", { method: "POST", body: JSON.stringify({ inviteToken }) });
    await openSession(session);
  } catch (error) { report(error, "The local server could not be reached. Check that npm run dev is running."); }
  finally { button.disabled = false; }
});

element("logout-button").addEventListener("click", async () => {
  element("logout-button").disabled = true;
  try {
    await api("/api/session", { method: "DELETE" });
    clearSession();
    feedback();
  } catch (error) {
    element("logout-button").disabled = false;
    report(error, "Sign out could not be completed. Please try again.");
  }
});

// Keep the same id for a retry after a lost response: acceptance may have succeeded.
let pendingSend = null;
element("message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = element("message-input").value;
  if (!text.trim() || !state.session || state.sending) return;
  const epoch = state.epoch;
  state.sending = true;
  element("send-button").disabled = true;
  feedback();
  if (!pendingSend || pendingSend.text !== text || pendingSend.conversationId !== state.session.conversationId) {
    pendingSend = { text, clientMessageId: crypto.randomUUID(), conversationId: state.session.conversationId };
  }
  try {
    await api(`/api/conversations/${encodeURIComponent(state.session.conversationId)}/messages`, { method: "POST", body: JSON.stringify({ text, clientMessageId: pendingSend.clientMessageId }) });
    if (epoch !== state.epoch) return;
    pendingSend = null;
    if (element("message-input").value === text) element("message-input").value = "";
    resizeComposer();
    await refreshConversation();
    element("message-input").focus();
  } catch (error) {
    if (epoch === state.epoch) report(error, "The send could not be confirmed. Try again to check the same message safely.");
  } finally {
    if (epoch === state.epoch) { state.sending = false; element("send-button").disabled = false; }
  }
});

async function setMode(mode) {
  if (!state.session || state.handoffBusy) return;
  const controls = handoffControls(state.health, state.conversation?.mode);
  if (mode === "bot" && !controls.showResume) { feedback(controls.notice); return; }
  const epoch = state.epoch;
  state.handoffBusy = true;
  element("support-button").disabled = true;
  element("return-button").disabled = true;
  feedback();
  try {
    await api(`/api/conversations/${encodeURIComponent(state.session.conversationId)}/handoff`, { method: "POST", body: JSON.stringify({ mode }) });
    if (epoch === state.epoch) await refreshConversation();
  } catch (error) {
    if (epoch === state.epoch) report(error, "The support mode could not be changed. Please try again.");
  } finally {
    if (epoch === state.epoch) {
      state.handoffBusy = false;
      renderHandoffControls(state.conversation?.mode);
    }
  }
}
element("support-button").addEventListener("click", () => { void setMode("human"); });
element("return-button").addEventListener("click", () => { void setMode("bot"); });

function resizeComposer() {
  const input = element("message-input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}
element("message-input").addEventListener("input", resizeComposer);
element("message-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); element("message-form").requestSubmit(); }
});
element("first-message-button").addEventListener("click", () => {
  element("message-input").value = "What can you help me with?";
  resizeComposer();
  element("message-input").focus();
});

// The secondary panels submit the same explicit commands as a conversation.
// Credentials and short-lived deletion tokens never enter browser storage.
const panelTitles = { memory: "Saved memory", reminders: "Reminders", actions: "Approvals & calendar", account: "Your account", support: "Staff workspace" };
const panelPaths = { memory: "/api/memories", reminders: "/api/reminders", actions: "/api/actions", account: "/api/account", support: "/api/operator/support" };
let fieldSequence = 0;
function dom(tag, className = "", text = "") {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text) result.textContent = text;
  return result;
}
function panelStatus(message = "", error = false) {
  element("control-status").textContent = message;
  element("control-status").classList.toggle("control-error", error);
}
function section(title, description = "") {
  const result = dom("section", "control-section");
  result.append(dom("h3", "", title));
  if (description) result.append(dom("p", "", description));
  return result;
}
function button(label, handler, className = "button button-secondary") {
  const result = dom("button", className, label);
  result.type = "button";
  result.addEventListener("click", () => {
    try { void Promise.resolve(handler()).catch((error) => panelStatus(error instanceof Error ? error.message : "The request could not be completed.", true)); }
    catch (error) { panelStatus(error instanceof Error ? error.message : "The request could not be completed.", true); }
  });
  return result;
}
function submit(label, form) {
  const result = dom("button", "button button-primary", label);
  result.type = "submit";
  form.append(result);
  return result;
}
function field(form, label, options = {}) {
  const wrapper = dom("div", "control-field");
  const input = document.createElement(options.options ? "select" : "input");
  input.id = `control-field-${++fieldSequence}`;
  const caption = dom("label", "", label);
  caption.htmlFor = input.id;
  if (options.options) {
    for (const [value, text] of options.options) {
      const option = dom("option", "", text);
      option.value = value;
      input.append(option);
    }
  } else input.type = options.type || "text";
  if (options.maxLength) input.maxLength = options.maxLength;
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.value !== undefined) input.value = String(options.value);
  input.required = options.required !== false;
  if (options.type === "password") { input.autocomplete = "off"; input.spellcheck = false; }
  wrapper.append(caption, input);
  if (options.hint) wrapper.append(dom("small", "", options.hint));
  form.append(wrapper);
  return input;
}
function line(value, maximum = 300) {
  if (/[\r\n\u0085\u2028\u2029\x00-\x1f\x7f]/.test(value)) throw new Error("Use one plain-text line for each field.");
  const result = value.trim();
  if (!result || result.length > maximum) throw new Error(`Use from 1 through ${maximum} characters.`);
  return result;
}
function id(value, prefix) {
  if (typeof value !== "string" || !new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, "i").test(value)) {
    throw new Error("This item's identifier is unavailable. Refresh the panel before trying again.");
  }
  return value.toLowerCase();
}
function readableDate(value) {
  if (value === null || value === undefined) return "Awaiting outcome";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Time unavailable" : date.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}
function explicitTime(value) {
  const result = line(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new Error("Use an ISO time with an explicit offset or Z, such as 2026-11-02T09:00:00-05:00.");
  }
  return result;
}
async function panelTask(operation, success = "") {
  if (!state.session || state.controlBusy) return false;
  const epoch = state.epoch;
  state.controlBusy = true;
  element("control-body").inert = true;
  element("control-body").setAttribute("aria-busy", "true");
  panelStatus("Working…");
  try {
    await operation();
    if (epoch === state.epoch && state.panel !== "conversation") panelStatus(success);
    return true;
  } catch (error) {
    if (epoch === state.epoch) panelStatus(error instanceof Error ? error.message : "The request could not be completed. Please try again.", true);
    return false;
  } finally {
    if (epoch === state.epoch) {
      state.controlBusy = false;
      element("control-body").inert = false;
      element("control-body").removeAttribute("aria-busy");
    }
  }
}
async function sendControl(text, key = text) {
  return panelTask(async () => {
    const epoch = state.epoch;
    const conversationId = state.session.conversationId;
    let pending = pendingCommands.get(key);
    if (!pending || pending.text !== text || pending.conversationId !== conversationId) {
      pending = { text, conversationId, clientMessageId: crypto.randomUUID() };
      pendingCommands.set(key, pending);
    }
    await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, { method: "POST", body: JSON.stringify({ text, clientMessageId: pending.clientMessageId }) });
    if (epoch !== state.epoch) return;
    pendingCommands.delete(key);
    await refreshConversation();
    if (state.panel !== "conversation") await loadPanel(state.panel);
  }, "Command accepted. Review its confirmation in the conversation.");
}
function commandForm(form, build, key) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try { void sendControl(build(), key); }
    catch (error) { panelStatus(error instanceof Error ? error.message : "Check the form fields.", true); }
  });
}
async function showPanel(name) {
  if (!state.session || (name !== "conversation" && !Object.hasOwn(panelPaths, name))) return;
  state.panel = name;
  state.panelRequest += 1;
  state.deletionIntent = null;
  state.channelLink = null;
  clearInterval(state.staffPoll); state.staffPoll = null;
  element("conversation-panel").hidden = name !== "conversation";
  element("control-panel").hidden = name === "conversation";
  for (const control of document.querySelectorAll(".control-nav [data-panel]")) {
    if (control.dataset.panel === name) control.setAttribute("aria-current", "page"); else control.removeAttribute("aria-current");
  }
  if (name === "conversation") { element("control-body").replaceChildren(); element("message-input").focus(); return; }
  element("control-title").textContent = panelTitles[name];
  element("control-title").focus();
  await loadPanel(name);
}
async function loadPanel(name) {
  if (!state.session || name === "conversation") return;
  const epoch = state.epoch;
  const request = ++state.panelRequest;
  if (name === "account") state.deletionIntent = null;
  panelStatus("Loading current account state…");
  const body = element("control-body");
  body.replaceChildren();
  try {
    let data;
    if (name === "account") {
      const [account, usage, bindings] = await Promise.all([api(panelPaths[name]), api("/api/usage").catch(() => null), api("/api/channel-bindings").catch(() => null)]);
      data = { ...account, usage, bindings };
    } else if (name === "actions") {
      const [actions, google, googleActions] = await Promise.all([api(panelPaths[name]),
        api("/api/calendar/google").catch(() => null), api("/api/calendar/google/actions").catch(() => null)]);
      data = { ...actions, google, googleActions };
    } else data = await api(panelPaths[name]);
    if (epoch !== state.epoch || request !== state.panelRequest || state.panel !== name) return;
    ({ memory: renderMemory, reminders: renderReminders, actions: renderActions, account: renderAccount, support: renderSupport })[name](data);
    panelStatus();
  } catch (error) {
    if (epoch !== state.epoch || request !== state.panelRequest || state.panel !== name) return;
    panelStatus(error instanceof Error ? error.message : "This panel is unavailable.", true);
    body.append(dom("p", "control-empty", "Your conversation and explicit commands remain available. Refresh to retry this view."));
    if (name === "memory") {
      body.append(button("Disable memory", () => sendControl("disable memory", "memory:disable")), button("Forget all saved facts", () => sendControl("forget all memories", "memory:forget-all")));
    }
    if (name === "support" || error.status === 401) body.append(identityConfirmationSection());
  }
}
for (const control of document.querySelectorAll("[data-panel]")) control.addEventListener("click", () => { void showPanel(control.dataset.panel); });
element("refresh-controls").addEventListener("click", () => { if (state.panel !== "conversation") void loadPanel(state.panel); });

function renderMemory(data) {
  const body = element("control-body");
  body.append(dom("p", "control-intro", "Only facts you explicitly save are remembered. Forgetting or correcting a fact resets future AI context; earlier messages remain visible. Do not send secrets."));
  const tools = dom("div", "control-toolbar");
  tools.append(dom("span", "badge badge-neutral", data.enabled ? "Memory on" : "Memory off · Facts retained"),
    button(data.enabled ? "Turn memory off" : "Turn memory on", () => sendControl(data.enabled ? "disable memory" : "enable memory", "memory:setting")),
    button("Export facts", () => panelTask(async () => {
      const epoch = state.epoch;
      const exported = await api("/api/memories/export");
      if (epoch === state.epoch && state.session) downloadJSON(exported, "plause-memory.json");
    }, "Memory export downloaded.")));
  body.append(tools);
  const save = section("Save a fact", data.enabled ? "Up to 10 facts, 300 characters each. No automatic extraction." : "Turn memory on to add or edit facts. You can still view, export, and forget them.");
  const form = dom("form", "control-form");
  const content = field(form, "Fact", { maxLength: 300, placeholder: "I prefer tea." });
  content.disabled = !data.enabled;
  submit("Remember this", form).disabled = !data.enabled;
  commandForm(form, () => `remember: ${line(content.value)}`, "memory:save");
  save.append(form);
  body.append(save);
  const facts = Array.isArray(data.memories) ? data.memories : [];
  if (!facts.length) body.append(dom("p", "control-empty", "No saved facts yet."));
  for (const fact of facts) {
    const item = dom("article", "control-item");
    item.append(dom("h4", "", String(fact.text)), dom("code", "", String(fact.id)));
    const edit = dom("form", "control-form");
    const replacement = field(edit, "Correction", { value: fact.text, maxLength: 300 });
    replacement.disabled = !data.enabled;
    submit("Save correction", edit).disabled = !data.enabled;
    commandForm(edit, () => `update memory ${id(fact.id, "mem")}: ${line(replacement.value)}`, `memory:edit:${fact.id}`);
    item.append(edit, button("Forget this fact", () => sendControl(`forget memory ${id(fact.id, "mem")}`, `memory:forget:${fact.id}`), "text-button danger-text"));
    body.append(item);
  }
  if (facts.length) body.append(button("Forget all saved facts", () => sendControl("forget all memories", "memory:forget-all"), "text-button danger-text"));
}

function messagingCopy(health) {
  const mock = health?.messaging === "mock";
  return { mock,
    reminderDelivery: mock ? "Notification delivery uses the simulated mock channel." : "Notifications use the configured delivery channel. A saved task is not proof of delivery.",
    reminderIntro: mock ? "Reminders are durable tasks. Notification delivery uses the simulated mock channel. Quiet hours, human support, and channel availability can delay delivery."
      : "Reminders are durable tasks. Notifications use the configured delivery channel. Quiet hours, human support, consent, and channel availability can delay delivery. Review each notification's delivery status.",
    demoEnabled: mock };
}
function renderReminders(data) {
  const body = element("control-body");
  body.append(dom("p", "control-intro", messagingCopy(state.health).reminderIntro));
  const tools = dom("div", "control-toolbar");
  tools.append(dom("span", "badge badge-neutral", data.enabled ? "Notifications on" : "Notifications off"),
    button(data.enabled ? "Turn notifications off" : "Turn notifications on", () => sendControl(`reminder notifications ${data.enabled ? "off" : "on"}`, "reminders:notifications")));
  body.append(tools);
  const create = section("Create a reminder");
  const form = dom("form", "control-form");
  const instruction = field(form, "Reminder", { maxLength: 300, placeholder: "Plan my day" });
  const kind = field(form, "Schedule", { options: [["once", "One time"], ["daily", "Every day"], ["weekly", "Every week"]] });
  const onceGroup = dom("div");
  const at = field(onceGroup, "Time with UTC offset", { placeholder: "2026-11-02T09:00:00-05:00", maxLength: 40, hint: "An explicit ISO offset or Z is required; no date is inferred." });
  const recurringGroup = dom("div", "control-form");
  const wallTime = field(recurringGroup, "Local time", { type: "time", value: "09:00" });
  const zone = field(recurringGroup, "IANA time zone", { value: data.timeZone || "UTC", maxLength: 80, placeholder: "America/New_York" });
  const weekdayGroup = dom("div");
  const weekday = field(weekdayGroup, "Day", { options: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => [day, day]) });
  form.append(onceGroup, recurringGroup, weekdayGroup);
  function scheduleFields() {
    onceGroup.hidden = kind.value !== "once"; recurringGroup.hidden = kind.value === "once"; weekdayGroup.hidden = kind.value !== "weekly";
    at.required = kind.value === "once"; wallTime.required = zone.required = kind.value !== "once"; weekday.required = kind.value === "weekly";
  }
  kind.addEventListener("change", scheduleFields); scheduleFields();
  submit("Create reminder", form);
  commandForm(form, () => {
    const schedule = kind.value === "once" ? `at ${explicitTime(at.value)}` : `every ${kind.value === "daily" ? "day" : weekday.value} at ${line(wallTime.value, 5)} ${line(zone.value, 80)}`;
    return `remind me ${schedule}: ${line(instruction.value)}`;
  }, "reminders:create");
  create.append(form); body.append(create);
  const settings = dom("details", "control-details");
  settings.append(dom("summary", "", "Time zone and quiet hours"));
  const zoneSection = section("Default reminder time zone");
  const zoneForm = dom("form", "control-form");
  const defaultZone = field(zoneForm, "IANA time zone", { value: data.timeZone || "UTC", maxLength: 80 });
  submit("Set time zone", zoneForm);
  commandForm(zoneForm, () => `reminder timezone ${line(defaultZone.value, 80)}`, "reminders:timezone");
  zoneSection.append(zoneForm); settings.append(zoneSection);
  const quietSection = section("Quiet hours", "Uses the default reminder time zone. Equal start and end times turn quiet hours off.");
  const quietForm = dom("form", "control-form");
  const start = field(quietForm, "Start", { type: "time", value: data.quietStart || "22:00" });
  const end = field(quietForm, "End", { type: "time", value: data.quietEnd || "08:00" });
  submit("Set quiet hours", quietForm);
  commandForm(quietForm, () => `reminder quiet hours ${line(start.value, 5)}-${line(end.value, 5)}`, "reminders:quiet");
  quietSection.append(quietForm); settings.append(quietSection); body.append(settings);
  const reminders = Array.isArray(data.reminders) ? data.reminders : [];
  if (!reminders.length) body.append(dom("p", "control-empty", "No reminders yet."));
  for (const reminder of reminders) {
    const item = dom("article", "control-item");
    item.append(dom("h4", "", String(reminder.instruction)), dom("code", "", String(reminder.id)),
      dom("p", "", `${reminder.status} · Next: ${readableDate(reminder.nextRunAt)}`), dom("p", "", scheduleDescription(reminder.schedule)));
    const actions = dom("div", "control-item-actions");
    if (reminder.status === "active" || reminder.status === "paused") {
      const operation = reminder.status === "active" ? "pause" : "resume";
      actions.append(button(operation === "pause" ? "Pause" : "Resume", () => sendControl(`${operation} reminder ${id(reminder.id, "rem")}`, `reminders:${operation}:${reminder.id}`)),
        button("Cancel reminder", () => sendControl(`cancel reminder ${id(reminder.id, "rem")}`, `reminders:cancel:${reminder.id}`), "text-button danger-text"));
    }
    item.append(actions); body.append(item);
  }
}
function scheduleDescription(schedule) {
  if (!schedule || typeof schedule !== "object") return "Schedule unavailable";
  if (schedule.kind === "once") return `One time · ${readableDate(schedule.at)}`;
  const day = schedule.kind === "weekly" ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][schedule.weekday] || "week" : "day";
  return `Every ${day} at ${schedule.time} ${schedule.timeZone}`;
}

function approvalReview(approval) {
  const args = approval.arguments;
  if (approval.toolName === "reminder.create") {
    const schedule = args?.schedule;
    const wallTimeValid = typeof schedule?.time === "string" && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(schedule.time);
    const zoneValid = typeof schedule?.timeZone === "string" && schedule.timeZone.length > 0;
    const validSchedule = schedule?.kind === "once" ? Number.isSafeInteger(schedule.at) && Number.isFinite(new Date(schedule.at).getTime())
      : (schedule?.kind === "daily" || schedule?.kind === "weekly") && wallTimeValid && zoneValid
        && (schedule.kind !== "weekly" || Number.isInteger(schedule.weekday) && schedule.weekday >= 0 && schedule.weekday <= 6);
    const complete = typeof args?.instruction === "string" && args.instruction.trim().length > 0 && validSchedule;
    const exactSchedule = schedule?.kind === "once" && validSchedule ? `UTC: ${new Date(schedule.at).toISOString()}\nExact timestamp: ${schedule.at}`
      : `Exact schedule: ${JSON.stringify(schedule) ?? "Unavailable"}`;
    return { title: "Reminder proposal · reminder.create", approveLabel: "Approve exact reminder", complete,
      text: `Reminder: ${args?.instruction ?? "Unavailable"}\nSchedule: ${scheduleDescription(schedule)}\n${exactSchedule}`,
      effect: `Approval creates a durable reminder and enables account-wide reminder notifications. Quiet hours still apply. ${messagingCopy(state.health).reminderDelivery}` };
  }
  if (approval.toolName === "calendar.create") return { title: "Simulated calendar proposal · calendar.create", approveLabel: "Approve exact simulated event",
    complete: typeof args?.title === "string" && args.title.trim().length > 0 && typeof args?.startsAt === "string"
      && Number.isFinite(Date.parse(args.startsAt)) && Number.isInteger(args?.durationMinutes) && args.durationMinutes >= 1 && args.durationMinutes <= 480,
    text: `Title: ${args?.title ?? "Unavailable"}\nStart: ${args?.startsAt ?? "Unavailable"}\nDuration: ${args?.durationMinutes ?? "Unavailable"} minutes`,
    effect: "Approval creates one simulated event. No real calendar entry is created." };
  return { title: "Unsupported proposal", approveLabel: "Approval unavailable", complete: false,
    text: "This proposal type cannot be reviewed here. It has not been approved.", effect: "Reject this proposal or review it through a supported control." };
}

function googleAuthorizationLink(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("The Google authorization link is unavailable. Refresh and try again."); }
  if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password) {
    throw new Error("The Google authorization link is unavailable. Refresh and try again.");
  }
  const link = dom("a", "button button-primary", "Open Google permission review");
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  return link;
}

function googleApprovalReview(approval) {
  const args = approval.arguments;
  const update = approval.toolName === "google_calendar.update";
  const supported = update || approval.toolName === "google_calendar.create";
  const baseValid = typeof args?.title === "string" && args.title.trim().length > 0 && args.title.length <= 200
    && typeof args?.startsAt === "string" && Number.isFinite(Date.parse(args.startsAt))
    && Number.isInteger(args?.durationMinutes) && args.durationMinutes >= 1 && args.durationMinutes <= 480;
  const targetValid = !update || typeof args?.eventId === "string" && /^p[0-9a-f]{64}$/.test(args.eventId)
    && typeof args?.etag === "string" && /^"[^"\x00-\x20\x7f]{1,196}"$/.test(args.etag);
  const digestValid = typeof approval.argsHash === "string" && /^[0-9a-f]{64}$/.test(approval.argsHash);
  return { complete: supported && baseValid && targetValid && digestValid, update,
    title: !supported ? "Unsupported Google proposal" : update ? "Real Google event update" : "Real Google event creation",
    text: `Calendar: primary\nTool: ${approval.toolName ?? "Unavailable"}\nTitle: ${args?.title ?? "Unavailable"}\nStart: ${args?.startsAt ?? "Unavailable"}\nDuration: ${args?.durationMinutes ?? "Unavailable"} minutes${update ? `\nExact target event: ${args?.eventId ?? "Unavailable"}\nCurrent strong ETag: ${args?.etag ?? "Unavailable"}` : ""}\nArguments digest: ${approval.argsHash ?? "Unavailable"}` };
}

function googleApprovalsSection(connection, data) {
  const result = section("Google action review", "Approval authorizes the exact displayed change to your real primary Google Calendar. No attendees are invited. A digest identifies the saved arguments; it is not permission. A changed target/version requires a new review.");
  if (!data) {
    result.append(dom("p", "control-empty", "Google action state is unavailable. No approval has been sent. Refresh to retry."));
    return result;
  }
  const approvals = Array.isArray(data.approvals) ? data.approvals : [];
  const requests = Array.isArray(data.requests) ? data.requests : [];
  const pending = approvals.filter((approval) => approval.state === "pending");
  if (!pending.length) result.append(dom("p", "control-empty", "No pending Google approvals."));
  for (const approval of pending) {
    const review = googleApprovalReview(approval);
    const item = dom("article", "control-item");
    item.append(dom("h4", "", review.title), dom("code", "", String(approval.id)), dom("p", "approval-arguments", review.text),
      dom("p", "", `Expires: ${readableDate(approval.expiresAt)}`));
    const sameConversation = approval.conversationId === state.session?.conversationId;
    const expired = !Number.isFinite(Number(approval.expiresAt)) || Number(approval.expiresAt) <= Date.now();
    const canUse = connection.configured === true && connection.connected === true && connection.status === "connected";
    const approve = button(review.update ? "Approve exact real update" : "Approve exact real creation",
      () => sendControl(`approve ${id(approval.id, "gapproval")}`, `google:approve:${approval.id}`));
    const reject = button("Reject Google proposal", () => sendControl(`reject ${id(approval.id, "gapproval")}`, `google:reject:${approval.id}`), "text-button");
    approve.disabled = !canUse || !sameConversation || expired || !review.complete;
    reject.disabled = !sameConversation || expired;
    const controls = dom("div", "control-item-actions"); controls.append(approve, reject); item.append(controls);
    if (!sameConversation) item.append(dom("p", "control-inline-note", "Decide this proposal in its originating conversation."));
    if (expired) item.append(dom("p", "control-inline-note", "This proposal has expired."));
    if (!review.complete) item.append(dom("p", "control-inline-note", "The full supported arguments, target/version, or digest are unavailable. Approval is disabled."));
    if (!canUse) item.append(dom("p", "control-inline-note", "A configured active Google connection is required before approval."));
    result.append(item);
  }
  const unsettled = requests.filter((request) => request.state === "unknown" || request.state === "dispatched");
  for (const request of unsettled) {
    const item = dom("article", "control-item");
    item.append(dom("h4", "", "Google outcome awaiting confirmation"), dom("code", "", String(request.approvalId)),
      dom("p", "", `State: ${request.state}. Do not create or approve a replacement to force a retry. Checking reads the existing event; it does not resend the write.`));
    const check = button("Check existing Google action", () => sendControl(`check calendar action ${id(request.approvalId, "gapproval")}`, `google:check:${request.approvalId}`));
    const origin = approvals.find((approval) => approval.id === request.approvalId);
    check.disabled = !connection.configured || !connection.connected || connection.status !== "connected"
      || origin?.conversationId !== state.session?.conversationId;
    item.append(check); result.append(item);
  }
  const history = dom("details", "control-details");
  history.append(dom("summary", "", "Recent Google action states"));
  if (!approvals.length && !requests.length) history.append(dom("p", "control-empty", "No recorded Google actions."));
  for (const approval of approvals.filter((item) => item.state !== "pending")) {
    history.append(dom("p", "approval-arguments", `${approval.id}\n${approval.toolName} · ${approval.state}`));
  }
  for (const request of requests) history.append(dom("p", "approval-arguments", `${request.approvalId}\nRequest: ${request.state} · ${readableDate(request.createdAt)}${request.errorCode ? `\nStatus code: ${request.errorCode}` : ""}`));
  result.append(history);
  return result;
}

function googleCalendarSection(connection, actionData) {
  const result = section("Google Calendar · Real account", "Calendar access is a separate permission from account sign-in. The requested permission can view, create, change, and delete events on calendars you own. This connector uses only your primary calendar, supports approved create/update changes, and does not invite attendees. Connection alone does not approve an event change.");
  if (!connection) {
    result.append(dom("p", "control-empty", "Google connection state is unavailable. Refresh to check it; no connection or action has been started."));
    return result;
  }
  const connected = connection.connected === true;
  const configured = connection.configured === true;
  const canUse = connected && configured && connection.status === "connected";
  const label = !configured ? "Google provider configuration unavailable" : connected ? "Google connection saved" : "Google not connected";
  result.append(dom("span", "badge badge-neutral", label), dom("p", "", `Status: ${connection.status ?? "Unavailable"}`));
  if (connection.scope) result.append(dom("p", "approval-arguments", `Permission scope: ${connection.scope}`));
  const controls = dom("div", "control-toolbar");
  const authorization = dom("div", "control-inline-note");
  const needsReauthorization = connection.status === "reauthorization_required";
  const revocationPending = connection.revocationPending === true;
  const connect = button(revocationPending ? "Provider revocation unresolved" : connected ? "Google connection active" : needsReauthorization ? "Clear access before reconnecting" : "Review Google connection", () => panelTask(async () => {
    const epoch = state.epoch;
    const response = await api("/api/calendar/google/connect", { method: "POST" });
    if (epoch !== state.epoch || state.panel !== "actions") return;
    const link = googleAuthorizationLink(response.authorizationUrl);
    authorization.replaceChildren(dom("p", "", "Review the requested access on Google before granting it. No event is changed by opening this link. After returning, refresh this panel to read the saved connection state."), link);
    connect.disabled = true;
  }, "Google permission review is ready. Open the link only if you want to continue."));
  connect.disabled = !configured || connected || needsReauthorization || revocationPending;
  controls.append(connect);
  if (!revocationPending && (connected || Number(connection.revision) > 0 || needsReauthorization || connection.status === "pending")) {
    result.append(dom("p", "control-inline-note", "Disconnecting resets future AI context and cancels older pending automatic replies across your account. Saved facts, reminder tasks, transcript messages, and delivered replies remain. Provider grant revocation is best effort."));
    controls.append(button(connected ? "Disconnect Google Calendar" : "Clear local Google access", () => panelTask(async () => {
      const epoch = state.epoch;
      const outcome = await api("/api/calendar/google", { method: "DELETE" });
      if (epoch !== state.epoch || state.panel !== "actions") return;
      await loadPanel("actions");
      if (epoch !== state.epoch || state.panel !== "actions") return;
      const revocation = outcome.providerRevocation === "confirmed" ? "Google confirmed provider grant revocation."
        : outcome.providerRevocation === "not_needed" ? "No stored Google grant needed revocation."
          : "Provider grant revocation could not be confirmed. Revoke Plause access in Google account settings if needed.";
      element("control-body").append(dom("p", "control-inline-note", revocation));
    }, "Local Google access was cleared. Review the provider revocation result below."), "text-button danger-text"));
  }
  result.append(controls, authorization);
  if (revocationPending) result.append(dom("p", "control-inline-note", "Local Google access is already removed. Provider revocation is still pending or unconfirmed, so reconnecting is blocked to protect a future grant. No automatic revoke retry or fence-clear control is available; operator/provider reconciliation is required."));
  else if (needsReauthorization) result.append(dom("p", "control-inline-note", "This grant needs fresh consent. Clear local access first, then explicitly review a new Google connection."));
  if (!configured) result.append(dom("p", "control-inline-note", "Google OAuth is not configured. Connection and real-calendar command forms stay disabled until private server credentials are configured."));

  const listing = section("Read primary-calendar events", "Reads only the explicit window when you submit. Use ISO times with UTC offsets, up to 31 days apart. Results appear in the conversation.");
  const listForm = dom("form", "control-form");
  const from = field(listForm, "Window start with UTC offset", { maxLength: 40, placeholder: "2026-11-02T00:00:00-05:00" });
  const to = field(listForm, "Window end with UTC offset", { maxLength: 40, placeholder: "2026-11-03T00:00:00-05:00" });
  submit("Read Google events", listForm).disabled = !canUse;
  commandForm(listForm, () => {
    const start = explicitTime(from.value); const end = explicitTime(to.value);
    const difference = Date.parse(end) - Date.parse(start);
    if (difference <= 0 || difference > 31 * 86_400_000) throw new Error("Choose a forward calendar window of at most 31 days.");
    return `google calendar events from ${start} to ${end}`;
  }, "google:list");
  listing.append(listForm); result.append(listing);

  const proposal = section("Propose a real Google event", "Submitting creates a proposal for review. A separate exact-ID approval is required before a real Google Calendar write.");
  const form = dom("form", "control-form");
  const title = field(form, "Google event title", { maxLength: 200 });
  const startsAt = field(form, "Google event start with UTC offset", { maxLength: 40, placeholder: "2026-11-02T09:00:00-05:00" });
  const duration = field(form, "Google event duration in minutes", { type: "number", value: "30" });
  duration.min = "1"; duration.max = "480"; duration.step = "1";
  submit("Propose Google event", form).disabled = !canUse;
  commandForm(form, () => {
    const minutes = Number(duration.value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) throw new Error("Choose from 1 through 480 whole minutes.");
    return `propose google calendar event at ${explicitTime(startsAt.value)} for ${minutes} minutes: ${line(title.value, 200)}`;
  }, "google:propose");
  proposal.append(form); result.append(proposal);

  const update = dom("details", "control-details");
  update.append(dom("summary", "", "Propose an update to a Plause-created Google event"),
    dom("p", "", "Read the current event first. Use its exact managed event ID and quoted strong ETag so a changed event cannot be overwritten. A separate approval is still required."));
  const updateForm = dom("form", "control-form");
  const eventId = field(updateForm, "Exact managed Google event ID", { maxLength: 65, placeholder: "p…" });
  const etag = field(updateForm, "Current strong ETag, including quotes", { maxLength: 198, placeholder: '"123456"' });
  const updateTitle = field(updateForm, "Replacement title", { maxLength: 200 });
  const updateStart = field(updateForm, "Replacement start with UTC offset", { maxLength: 40, placeholder: "2026-11-02T09:00:00-05:00" });
  const updateDuration = field(updateForm, "Replacement duration in minutes", { type: "number", value: "30" });
  updateDuration.min = "1"; updateDuration.max = "480"; updateDuration.step = "1";
  submit("Propose real Google update", updateForm).disabled = !canUse;
  commandForm(updateForm, () => {
    const target = line(eventId.value, 65); const version = line(etag.value, 198); const minutes = Number(updateDuration.value);
    if (!/^p[0-9a-f]{64}$/.test(target) || !/^"[^"\x00-\x20\x7f]{1,196}"$/.test(version)) throw new Error("Use the exact Plause-created event ID and its current quoted strong ETag.");
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) throw new Error("Choose from 1 through 480 whole minutes.");
    return `propose google calendar update ${target} etag ${version} at ${explicitTime(updateStart.value)} for ${minutes} minutes: ${line(updateTitle.value, 200)}`;
  }, "google:update");
  update.append(updateForm); result.append(update);
  result.append(googleApprovalsSection(connection, actionData));
  return result;
}

function renderActions(data) {
  const body = element("control-body");
  const copy = messagingCopy(state.health);
  const connected = data.calendar?.connected === true;
  body.append(dom("p", "control-intro", `Review exact reminder and calendar proposals before approving. ${copy.reminderDelivery} A separately connected Google account can authorize real calendar changes.`));
  body.append(googleCalendarSection(data.google, data.googleActions));
  if (copy.demoEnabled) {
  const tools = dom("div", "control-toolbar");
  tools.append(dom("span", "badge badge-neutral", connected ? "Simulated calendar connected" : "Simulated calendar disconnected"),
    button(connected ? "Disconnect demo calendar" : "Connect demo calendar", () => sendControl(connected ? "disconnect demo calendar" : "connect demo calendar", "actions:connection")));
  body.append(tools);
  const proposal = section("Propose a simulated event", "Review its immutable details before approving its exact ID. Approvals expire after ten minutes.");
  const form = dom("form", "control-form");
  const title = field(form, "Title", { maxLength: 200 });
  const startsAt = field(form, "Start with UTC offset", { maxLength: 40, placeholder: "2026-11-02T09:00:00-05:00", hint: "Choose a future time within 365 days." });
  const duration = field(form, "Duration in minutes", { type: "number", value: "30" });
  duration.min = "1"; duration.max = "480"; duration.step = "1";
  const proposalButton = submit("Request simulated approval", form);
  proposalButton.disabled = !connected;
  commandForm(form, () => {
    const minutes = Number(duration.value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) throw new Error("Choose from 1 through 480 whole minutes.");
    return `propose calendar event at ${explicitTime(startsAt.value)} for ${minutes} minutes: ${line(title.value, 200)}`;
  }, "actions:propose");
  proposal.append(form); body.append(proposal);
  }
  const approvals = Array.isArray(data.approvals) ? data.approvals : [];
  const pending = approvals.filter((approval) => approval.state === "pending");
  const approvalsSection = section("Pending approvals", "Review every argument and its effect before approving the exact ID. Proposals expire after ten minutes; a draft has not created a reminder or event.");
  if (!pending.length) approvalsSection.append(dom("p", "control-empty", "No pending approvals."));
  for (const approval of pending) {
    const item = dom("article", "control-item");
    const review = approvalReview(approval);
    item.append(dom("h4", "", review.title), dom("code", "", String(approval.id)),
      dom("p", "approval-arguments", review.text), dom("p", "control-inline-note", review.effect),
      dom("p", "", `Expires: ${readableDate(approval.expiresAt)}`));
    const actions = dom("div", "control-item-actions");
    const sameConversation = approval.conversationId === state.session?.conversationId;
    const expired = !Number.isFinite(Number(approval.expiresAt)) || Number(approval.expiresAt) <= Date.now();
    const approve = button(review.approveLabel, () => sendControl(`approve ${id(approval.id, "approval")}`, `actions:approve:${approval.id}`));
    const reject = button("Reject", () => sendControl(`reject ${id(approval.id, "approval")}`, `actions:reject:${approval.id}`), "text-button");
    approve.disabled = !sameConversation || expired || !review.complete || approval.toolName === "calendar.create" && !copy.demoEnabled;
    reject.disabled = !sameConversation || expired;
    actions.append(approve, reject);
    item.append(actions);
    if (!sameConversation) item.append(dom("p", "control-inline-note", "This approval must be decided in its originating conversation."));
    if (expired) item.append(dom("p", "control-inline-note", "This approval has expired. Refresh for its current status."));
    if (!review.complete) item.append(dom("p", "control-inline-note", "The full supported arguments are unavailable. Approval is disabled."));
    if (approval.toolName === "calendar.create" && !copy.demoEnabled) item.append(dom("p", "control-inline-note", "Simulated calendar approvals are available only with the mock messaging provider."));
    approvalsSection.append(item);
  }
  body.append(approvalsSection);
  if (!copy.demoEnabled) return;
  const events = section("Simulated events · Next 30 days");
  const items = Array.isArray(data.events) ? data.events : [];
  if (!items.length) events.append(dom("p", "control-empty", "No simulated events in this window."));
  for (const event of items) {
    const item = dom("article", "control-item");
    item.append(dom("h4", "", String(event.title)), dom("code", "", String(event.id)), dom("p", "", `${event.startsAt} · ${event.durationMinutes} minutes · ${event.status} · Simulated`));
    if (event.status === "scheduled") {
      const cancel = button("Cancel simulated event", () => sendControl(`cancel demo event ${id(event.id, "event")}`, `actions:cancel:${event.id}`), "text-button danger-text");
      cancel.disabled = !connected; item.append(cancel);
    }
    events.append(item);
  }
  body.append(events);
}

function downloadJSON(data, filename) {
  const objectURL = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = objectURL; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
}
function invitationSession(session) { return session?.authentication === "development_invitation"; }
function identityConfirmationSection(authentication = state.session?.authentication) {
  const result = section("Confirm this account", "Linking a channel, staff work, and account deletion require a recent account confirmation. Completing sign-in confirms the provider account; it does not promise password or MFA reentry.");
  if (invitationSession({ authentication })) {
    const form = dom("form", "control-form");
    const invitation = field(form, "Local invitation for this account", { type: "password", maxLength: 200 });
    submit("Confirm local account", form);
    form.addEventListener("submit", (event) => {
      event.preventDefault(); let inviteToken = invitation.value.trim(); invitation.value = "";
      if (!inviteToken) return;
      const accountId = state.session?.user.id;
      void panelTask(async () => {
        let session;
        try { session = await api("/api/session", { method: "POST", body: JSON.stringify({ inviteToken }) }); }
        finally { inviteToken = ""; }
        if (session.user.id !== accountId) { clearSession(); await openSession(session); feedback("The invitation signed into a different local account. No pending control was continued."); return; }
        clearSession(); await openSession(session); await showPanel("account");
      }, "Account confirmed. Start the intended control again.");
    }); result.append(form);
  } else {
    const destination = dom("div");
    const review = button("Review account confirmation", () => panelTask(() => startIdentity("reauth", destination), "Continue using the Google link. No pending mutation will be resumed automatically."));
    review.disabled = state.auth?.configured !== true;
    result.append(review, destination);
  }
  return result;
}
function channelBindingsSection(data) {
  const result = section("Messaging channel links", "Linking requires both a message from the channel and a separate confirmation in this signed-in account. Apple enrollment and a connected messaging provider are still required for real Messages. Local mock proof is a development fixture.");
  if (typeof state.auth?.appleEntryUrl === "string") {
    let entry;
    try {
      const url = new URL(state.auth.appleEntryUrl);
      if (url.origin === "https://bcrw.apple.com" && /^\/urn:biz:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.pathname)
        && !url.username && !url.password && !url.search && !url.hash) entry = url.href;
    } catch { /* An invalid configured link is never followed. */ }
    if (entry) {
      const link = dom("a", "button button-secondary", "Open Plause in Messages");
      link.href = entry; link.target = "_blank"; link.rel = "noopener noreferrer"; link.referrerPolicy = "no-referrer";
      result.append(link, dom("p", "control-inline-note", "This opens the configured Apple business conversation. After preparing a link below, send its code manually. No one-time code or account credential is included in this URL."));
    }
  }
  const bindings = Array.isArray(data?.bindings) ? data.bindings : [];
  if (!data) result.append(dom("p", "control-empty", "Channel bindings are unavailable. Refresh before changing access."));
  else if (!bindings.length) result.append(dom("p", "control-empty", "No messaging channels linked."));
  for (const binding of bindings) {
    const item = dom("article", "control-item");
    item.append(dom("h4", "", `${binding.channel} · ${binding.status}`), dom("p", "", `${binding.provider} · ${binding.subjectHint}\nReplies: ${binding.replyConsentAt ? "consented" : "not recorded"}\nProactive reminders: ${binding.proactiveConsentAt ? "consented" : "not recorded"}`));
    if (binding.status === "active") item.append(button("Revoke this channel", () => panelTask(async () => {
      await api(`/api/channel-bindings/${encodeURIComponent(binding.id)}`, { method: "DELETE" }); await loadPanel("account");
    }, "Channel revoked. Pending messages on that channel were cancelled; delivered messages remain."), "text-button danger-text"));
    result.append(item);
  }
  const form = dom("form", "control-form");
  const replies = field(form, "Allow Plause to reply on the channel being linked", { type: "checkbox" });
  const proactive = field(form, "Also allow proactive reminder notifications on that channel", { type: "checkbox", required: false });
  submit("Prepare a five-minute channel link", form);
  const progress = dom("div");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!replies.checked) { panelStatus("Consent to replies is required to link this channel.", true); return; }
    void panelTask(async () => {
      const epoch = state.epoch;
      const challenge = await api("/api/channel-links", { method: "POST", body: JSON.stringify({ replyConsent: true, proactiveConsent: proactive.checked }) });
      if (epoch !== state.epoch || state.panel !== "account" || !progress.isConnected) return;
      state.channelLink = { id: challenge.id, epoch };
      progress.replaceChildren(dom("p", "approval-arguments", `Send this exact command from the channel you control:\n${challenge.command}\nExpires: ${readableDate(challenge.expiresAt)}`),
        dom("p", "control-inline-note", "Keep this one-time code private. It is not a message to the AI. Confirm below only after reviewing the server-verified channel proof."));
      const proofArea = dom("div");
      progress.append(button("Check message proof", () => panelTask(async () => {
        const current = state.channelLink;
        if (!current || current.epoch !== state.epoch) throw new Error("Prepare a new link first.");
        const proof = await api(`/api/channel-links/${encodeURIComponent(current.id)}`);
        if (current !== state.channelLink || !proofArea.isConnected) return;
        proofArea.replaceChildren(dom("p", "approval-arguments", `Status: ${proof.status}\nExpires: ${readableDate(proof.expiresAt)}`));
        if (proof.status === "proved" && proof.proof) {
          proofArea.append(dom("p", "approval-arguments", `Verified channel: ${proof.proof.channel}\nProvider: ${proof.proof.provider}\nBusiness: ${proof.proof.businessId}\nSubject: ${proof.proof.subjectHint}\nReply consent: ${proof.replyConsent ? "yes" : "no"}\nProactive consent: ${proof.proactiveConsent ? "yes" : "no"}`),
            button("Confirm this exact channel link", () => panelTask(async () => {
              if (current !== state.channelLink) throw new Error("Prepare a new link first.");
              await api(`/api/channel-links/${encodeURIComponent(current.id)}/confirm`, { method: "POST", body: "{}" });
              state.channelLink = null; await loadPanel("account");
            }, "The verified channel is linked to this account.")));
        }
      })), proofArea);
    }, "Send the code from the channel, then check its proof. No channel is linked yet.");
  });
  result.append(form, progress); return result;
}
function renderAccount(data) {
  const body = element("control-body");
  const authentication = data.authentication ?? state.session?.authentication;
  const local = invitationSession({ authentication });
  body.append(dom("p", "control-intro", `${data.user?.displayName || "Your account"} · ${local ? "Local development invitation" : "Provider-authenticated"} account. Keep exported conversation and control data private.`));
  body.append(identityConfirmationSection(authentication), channelBindingsSection(data.bindings));
  const counts = dom("dl", "account-counts");
  const labels = { conversations: "Conversations", messages: "Messages", memories: "Saved facts", activeReminders: "Active reminders", pendingApprovals: "Pending approvals" };
  for (const [key, label] of Object.entries(labels)) {
    const item = dom("div"); item.append(dom("dt", "", label), dom("dd", "", String(data.counts?.[key] ?? 0))); counts.append(item);
  }
  body.append(counts);
  const usageSection = section("Usage estimates", "Application accounting bounds are estimates. Provider billing remains authoritative; uncertain requests can retain a held reservation.");
  if (data.usage?.model) {
    const usage = data.usage;
    const dollars = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? (value / 1_000_000).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }) : "Unavailable";
    usageSection.append(dom("p", "", `Period: ${usage.period}\nApp ledger debit: ${dollars(usage.model.debitedMicroUsd)}\nHeld for uncertain requests: ${dollars(usage.model.heldMicroUsd)}\nRemaining user allowance: ${dollars(usage.model.remainingMicroUsd)}\nUser monthly budget: ${dollars(usage.model.userBudgetMicroUsd)}`));
    if (usage.chat) usageSection.append(dom("p", "", `Ordinary chat today: ${usage.chat.acceptedToday} / ${usage.chat.dailyLimit}. Personal controls are excluded.`));
    if (usage.search) usageSection.append(dom("p", "", `Search attempts today: ${usage.search.attemptsToday} / ${usage.search.dailyLimit ?? "configuration unavailable"}.`));
    if (usage.googleCalendar) usageSection.append(dom("p", "", `Google Calendar operations today: ${usage.googleCalendar.attemptsToday} / ${usage.googleCalendar.dailyLimit}. Uncertain attempts still count.`));
    if (usage.model.serviceBudgetAvailable === false) usageSection.append(dom("p", "", "The service model budget is unavailable."));
    if (usage.note) usageSection.append(dom("p", "", String(usage.note)));
  } else usageSection.append(dom("p", "", "Usage estimates are currently unavailable. Account controls remain available."));
  body.append(usageSection);
  const exportSection = section("Export this account", "Download current personal controls and all paginated conversation messages. The export is a live snapshot; changes during download can affect later pages. Credentials and retained billing tombstones are excluded.");
  exportSection.append(button("Download account JSON", () => panelTask(exportAccount, "Account export downloaded. Keep the file private.")));
  body.append(exportSection);
  const deletion = section("Delete this account", "Permanently removes account access, transcripts, saved facts, reminders, approvals, demo calendar data, and stored Google credentials. Minimal billing metadata and possible-charge holds remain. Delivered messages, exported files, and real Google events are not deleted. Disconnect Google first to request grant revocation, or revoke Plause access in Google account settings; account erasure does not guarantee provider grant revocation.");
  deletion.classList.add("danger-section");
  const form = dom("form", "control-form");
  const invitation = local ? field(form, "Invitation key for this account", { type: "password", maxLength: 200 }) : null;
  if (!local) form.append(dom("p", "control-inline-note", "Confirm this account with Google above within five minutes, then prepare the deletion review. A second click is required for final deletion."));
  const phrase = field(form, "Type DELETE MY PLAUSE ACCOUNT", { maxLength: 40, placeholder: "DELETE MY PLAUSE ACCOUNT" });
  submit("Prepare deletion review", form).className = "button button-danger";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    let inviteToken = invitation?.value.trim() ?? "";
    const confirmation = phrase.value;
    if (invitation) invitation.value = ""; phrase.value = "";
    if (confirmation !== "DELETE MY PLAUSE ACCOUNT" || local && !inviteToken) { inviteToken = ""; panelStatus("Confirm the account and type DELETE MY PLAUSE ACCOUNT exactly.", true); return; }
    const epoch = state.epoch;
    const request = state.panelRequest;
    void panelTask(async () => {
      let intent;
      try { intent = await api("/api/account/deletion-intent", { method: "POST", body: JSON.stringify({ ...(local ? { inviteToken } : {}), confirmation }) }); }
      finally { inviteToken = ""; }
      if (epoch !== state.epoch || state.panel !== "account" || request !== state.panelRequest) return;
      if (typeof intent?.confirmationToken !== "string" || !Number.isFinite(Number(intent.expiresAt)) || Number(intent.expiresAt) <= Date.now()) throw new Error("The deletion review is unavailable or expired. Prepare it again.");
      state.deletionIntent = { token: intent.confirmationToken, expiresAt: Number(intent.expiresAt), epoch };
      renderDeletionReview({ effect: intent.effect, expiresAt: intent.expiresAt });
    }, "Review the effects. A separate final action is required to delete the account.");
  });
  deletion.append(form); body.append(deletion);
}
async function exportAccount() {
  const epoch = state.epoch;
  let cursor = 0;
  let combined = null;
  for (let pageNumber = 0; pageNumber < 500; pageNumber += 1) {
    if (epoch !== state.epoch || !state.session) throw new Error("The session changed; no export was downloaded.");
    const page = await api(`/api/account/export${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`);
    if (epoch !== state.epoch) return;
    if (!Array.isArray(page?.messages)) throw new Error("The export response was incomplete. No partial file was downloaded.");
    if (!combined) combined = { version: page.version, exportedAt: page.exportedAt, account: page.account, controls: page.controls, snapshot: page.snapshot, messages: [] };
    combined.messages.push(...page.messages);
    if (page.nextCursor === null) { downloadJSON(combined, "plause-account.json"); return; }
    if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor) throw new Error("The export cursor did not advance. No partial file was downloaded.");
    cursor = page.nextCursor;
    panelStatus(`Collecting account export · ${pageNumber + 1} pages`);
  }
  throw new Error("The export exceeded the 500-page safety limit. No partial file was downloaded.");
}

const supportPath = (conversationId, action = "") => `/api/operator/support/${encodeURIComponent(conversationId)}${action ? `/${action}` : ""}`;
function supportMessages(container, messages) {
  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    const item = dom("article", "control-item");
    item.append(dom("h4", "", message.role === "user" ? "Customer" : message.model === "plause-human" ? "Human support" : message.role === "system" ? "Conversation update" : "Plause"),
      dom("p", "message-text", String(message.text ?? "")), dom("p", "control-inline-note", `${readableDate(message.createdAt)} · ${message.status}`));
    fragment.append(item);
  }
  container.replaceChildren(fragment);
}
async function refreshStaffThread() {
  if (document.visibilityState !== "visible" || state.panel !== "support" || !state.supportClaim || state.staffPolling || state.controlBusy) return;
  state.staffPolling = true;
  const claim = state.supportClaim, epoch = state.epoch;
  try {
    if (claim.expiresAt <= Date.now()) throw new Error("The support claim expired. Return to the inbox and claim it again.");
    if (claim.expiresAt < Date.now() + 120_000) {
      const renewed = await api(supportPath(claim.conversationId, "renew"), { method: "POST", body: JSON.stringify({ claimVersion: claim.claimVersion }) });
      if (state.supportClaim === claim && epoch === state.epoch) { Object.assign(claim, renewed); const expiry = element("staff-claim-expiry"); if (expiry) expiry.textContent = `Claim expires: ${readableDate(claim.expiresAt)}`; }
    }
    const thread = await api(supportPath(claim.conversationId));
    if (epoch !== state.epoch || state.supportClaim !== claim || state.panel !== "support") return;
    const target = element("staff-transcript"); if (target) supportMessages(target, thread.messages);
  } catch (error) {
    if (epoch === state.epoch && state.supportClaim === claim && state.panel === "support") {
      clearInterval(state.staffPoll); state.staffPoll = null;
      panelStatus(error instanceof Error ? error.message : "Support access could not be confirmed.", true);
      state.staffPending = null; state.supportClaim = null;
      element("control-body").replaceChildren(dom("p", "control-empty", "The claimed transcript was cleared because access could not be confirmed."), identityConfirmationSection());
    }
  } finally { state.staffPolling = false; }
}
async function openStaffThread(conversationId) {
  const epoch = state.epoch;
  const thread = await api(supportPath(conversationId));
  if (epoch !== state.epoch || state.panel !== "support") return;
  clearInterval(state.staffPoll); state.staffPoll = null;
  state.supportClaim = thread.claim;
  const claim = state.supportClaim;
  const body = element("control-body"); body.replaceChildren();
  const details = section("Claimed support conversation", "Staff replies are queued through the durable delivery path. A queued reply is not confirmation of delivery. Claims expire after five minutes and are renewed only while this workspace is open and your account confirmation remains recent.");
  details.append(dom("code", "", conversationId));
  const expiry = dom("p", "control-inline-note", `Claim expires: ${readableDate(claim.expiresAt)}`); expiry.id = "staff-claim-expiry"; details.append(expiry);
  const controls = dom("div", "control-item-actions");
  const mutate = (action) => panelTask(async () => {
    const result = await api(supportPath(conversationId, action), { method: "POST", body: JSON.stringify({ claimVersion: claim.claimVersion }) });
    if (state.supportClaim !== claim || epoch !== state.epoch || state.panel !== "support") return;
    if (action === "renew") { Object.assign(claim, result); expiry.textContent = `Claim expires: ${readableDate(claim.expiresAt)}`; }
    else { state.supportClaim = null; state.staffPending = null; clearInterval(state.staffPoll); state.staffPoll = null; await loadPanel("support"); }
  }, action === "resume" ? "Claim closed and this conversation returned to the agent. Earlier cancelled messages are not replayed." : action === "release" ? "Claim released; the conversation remains in human support mode." : "Claim renewed.");
  const renew = button("Renew claim", () => mutate("renew")); renew.disabled = thread.replyAvailable !== true;
  const resume = button("Close claim and resume agent", () => mutate("resume"), "text-button"); resume.disabled = thread.replyAvailable !== true;
  controls.append(renew, button("Release to support inbox", () => mutate("release"), "text-button"), resume,
    button("Back to support inbox", () => loadPanel("support"), "text-button"));
  details.append(controls); body.append(details);
  const transcript = dom("div"); transcript.id = "staff-transcript"; transcript.setAttribute("aria-label", "Claimed support transcript");
  supportMessages(transcript, thread.messages); body.append(transcript);
  if (thread.nextBefore) {
    const history = dom("div"); let before = thread.nextBefore;
    const older = button("Load earlier support messages", () => panelTask(async () => {
      const page = await api(`${supportPath(conversationId)}?before=${encodeURIComponent(before)}`);
      if (state.supportClaim !== claim || epoch !== state.epoch || !history.isConnected) return;
      const block = dom("div"); supportMessages(block, page.messages); history.prepend(block);
      before = page.nextBefore; older.disabled = !before;
    }));
    body.insertBefore(history, transcript); body.append(older);
  }
  const replySection = section("Reply as human support", "Send a deliberate staff response. Releasing the claim, returning to the agent, or revoking the role cancels queued replies; an already dispatched send may have an unknown outcome.");
  const form = dom("form", "control-form"); form.id = "staff-reply-form";
  const input = document.createElement("textarea"); input.id = `staff-reply-${++fieldSequence}`; input.rows = 4; input.maxLength = 4000; input.required = true;
  const label = dom("label", "", "Staff reply"); label.htmlFor = input.id;
  const wrapper = dom("div", "control-field"); wrapper.append(label, input); form.append(wrapper);
  submit("Queue staff reply", form).disabled = thread.replyAvailable !== true;
  if (thread.replyAvailable !== true) replySection.append(dom("p", "control-inline-note", "Provider ownership is unavailable. Use the configured provider staff workspace; this console cannot send or resume the agent."));
  form.addEventListener("submit", (event) => {
    event.preventDefault(); const text = input.value;
    if (!text.trim() || thread.replyAvailable !== true || state.supportClaim !== claim || state.controlBusy) return;
    const previous = state.staffPending;
    if (!previous || previous.text !== text || previous.conversationId !== conversationId || previous.claimVersion !== claim.claimVersion) state.staffPending = { text, conversationId, claimVersion: claim.claimVersion, clientMessageId: crypto.randomUUID() };
    const pending = state.staffPending;
    void panelTask(async () => {
      await api(supportPath(conversationId, "reply"), { method: "POST", body: JSON.stringify({ text: pending.text, claimVersion: pending.claimVersion, clientMessageId: pending.clientMessageId }) });
      if (epoch !== state.epoch || state.supportClaim !== claim) return;
      if (state.staffPending === pending) state.staffPending = null;
      if (input.value === text) input.value = "";
      const latest = await api(supportPath(conversationId));
      if (epoch === state.epoch && state.supportClaim === claim && transcript.isConnected) supportMessages(transcript, latest.messages);
    }, "Staff reply accepted into the outbox. Review its delivery status above.");
  });
  replySection.append(form); body.append(replySection);
  state.staffPoll = setInterval(() => { void refreshStaffThread(); }, 5000);
}
function renderSupport(data) {
  clearInterval(state.staffPoll); state.staffPoll = null; state.supportClaim = null;
  const body = element("control-body");
  body.append(dom("p", "control-intro", "Authorized staff only. Open a human-support conversation by claiming it before reading customer text. Roles and five-minute claims are checked on the server for every read and reply."));
  const coverage = data.coverage;
  body.append(dom("p", "control-inline-note", coverage?.configured ? `Configured coverage: ${coverage.hours} · ${coverage.timeZone} · ${coverage.contact}. Configuration does not verify current staffing.` : "Support coverage is not configured. This workspace does not establish a staffed service."));
  const conversations = Array.isArray(data.conversations) ? data.conversations : [];
  if (!conversations.length) body.append(dom("p", "control-empty", "No open human-support conversations."));
  for (const conversation of conversations) {
    const item = dom("article", "control-item");
    const active = Number(conversation.expiresAt) > Date.now() && !!conversation.operatorUserId;
    const own = active && conversation.operatorUserId === state.session?.user.id;
    const available = conversation.replyAvailable === true;
    item.append(dom("h4", "", String(conversation.customerDisplayName)), dom("code", "", conversation.conversationId),
      dom("p", "", `${conversation.channel} · ${readableDate(conversation.lastActivityAt)}\n${!available ? "Provider ownership unavailable" : active ? own ? "Claimed by you" : "Claimed by another staff member" : "Available to claim"}`));
    if (!available) item.append(dom("p", "control-inline-note", `Provider control: ${conversation.providerControl ?? "unknown"}. This provider-owned or unknown conversation is metadata-only here. Use the configured provider staff workspace. Plause cannot claim, reply, or resume the agent until provider control returns.`));
    const claim = button(own ? "Open your claimed conversation" : "Claim and open conversation", () => panelTask(async () => {
      const epoch = state.epoch;
      await api(supportPath(conversation.conversationId, "claim"), { method: "POST", body: "{}" });
      if (epoch === state.epoch && state.panel === "support") await openStaffThread(conversation.conversationId);
    })); claim.disabled = !available || active && !own; item.append(claim); body.append(item);
  }
  body.append(identityConfirmationSection());
  if (state.capabilities?.canManageOperators) {
    const grants = section("Staff roles", "Admin changes immediately invalidate that operator's claims and queued replies. Grants use exact Plause user IDs. Google bootstrap uses verified subject IDs configured on the server, never email addresses.");
    const list = dom("div");
    grants.append(button("Read current staff grants", () => panelTask(async () => {
      const response = await api("/api/operator/grants");
      if (list.isConnected) list.replaceChildren(...response.grants.map((grant) => dom("p", "approval-arguments", `${grant.userId}\n${grant.displayName} · ${grant.role} · ${grant.status} · revision ${grant.revision}`)));
    })), list);
    const form = dom("form", "control-form");
    const userId = field(form, "Exact Plause user ID", { maxLength: 200 });
    const role = field(form, "Role change", { options: [["support", "Grant support"], ["admin", "Grant admin"], ["revoke", "Revoke staff access"]] });
    const confirmed = field(form, "I reviewed the exact account and role change", { type: "checkbox" });
    submit("Apply explicit role change", form);
    form.addEventListener("submit", (event) => {
      event.preventDefault(); if (!confirmed.checked) return;
      void panelTask(async () => {
        await api("/api/operator/grants", { method: "POST", body: JSON.stringify({ userId: line(userId.value, 200), role: role.value === "revoke" ? null : role.value }) });
        await loadCapabilities(); await loadPanel("support");
      }, "Role change applied. Existing claims and queued replies for that operator were invalidated.");
    }); grants.append(form); body.append(grants);
    const operations = section("Delivery operations", "A global outbound pause holds delivery. Recovery wakes existing durable work; it does not authorize retrying uncertain provider writes or sends.");
    const status = dom("pre", "approval-arguments");
    operations.append(button("Read delivery status", () => panelTask(async () => { const value = await api("/api/operator/status"); if (status.isConnected) status.textContent = JSON.stringify(value, null, 2); })), status,
      button("Pause outbound delivery", () => panelTask(() => api("/api/operator/pause", { method: "POST", body: JSON.stringify({ paused: true }) }), "Outbound delivery paused.")),
      button("Resume outbound delivery", () => panelTask(() => api("/api/operator/pause", { method: "POST", body: JSON.stringify({ paused: false }) }), "Outbound delivery resumed; eligible durable work was woken.")),
      button("Wake eligible durable work", () => panelTask(() => api("/api/operator/recover", { method: "POST", body: "{}" }), "Recovery requested. Review delivery states; uncertain sends are not blindly retried.")));
    body.append(operations);
  }
}
function renderDeletionReview(intent) {
  const body = element("control-body"); body.replaceChildren();
  const review = section("Final account deletion review", String(intent.effect)); review.classList.add("danger-section");
  review.append(dom("p", "", `Review expires: ${readableDate(intent.expiresAt)}. The final button permanently deletes this account.`));
  review.append(button("Permanently delete this account", async () => {
    const current = state.deletionIntent;
    if (!current || current.epoch !== state.epoch || current.expiresAt <= Date.now()) { state.deletionIntent = null; panelStatus("This review expired. Return to Account and prepare a new deletion review.", true); return; }
    await panelTask(async () => {
      let confirmationToken = current.token;
      state.deletionIntent = null;
      let outcome;
      try { outcome = await api("/api/account", { method: "DELETE", body: JSON.stringify({ confirmationToken }) }); }
      finally { confirmationToken = ""; }
      clearSession(); feedback(outcome?.pending ? "Account access is disabled. Erasure is pending independent privacy-ledger recovery; completion is not yet confirmed. Previously delivered messages and downloaded exports remain outside the account." : "The account was deleted. Previously delivered messages and downloaded exports remain outside this account.");
    });
  }, "button button-danger"));
  review.append(button("Cancel and return to Account", async () => { state.deletionIntent = null; await loadPanel("account"); }, "text-button"));
  body.append(review);
}
window.addEventListener("pagehide", () => { state.deletionIntent = null; });

await Promise.all([
  loadHealth(),
  loadAuth(),
  loadCoverage(),
  (async () => {
    try { await openSession(await api("/api/me")); }
    catch (error) { if (error.status !== 401) report(error, "Could not check your local session. You can try signing in below."); }
  })(),
]);
