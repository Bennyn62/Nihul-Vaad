import { firebaseConfig, BUILDING_ID, TOTAL_UNITS } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc,
  updateDoc, query, where, orderBy, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { historicalData } from "./historicalData.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

const HEB_MONTHS = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];
const todayISO = () => new Date().toISOString().slice(0,10);
const fmtILS = (n) => "₪" + Math.round(n).toLocaleString("he-IL");
const $ = (id) => document.getElementById(id);

let STATE = {
  role: null,            // 'admin' | 'resident' | null
  residentUnitId: null,
  settings: { name: "ועד בית", address: "", fee: 80, signatureDataUrl: "" },
  units: [],              // [{id, number, currentName, currentPhone, history:[]}]
  transactions: [],        // cached for current year
  currentYear: new Date().getFullYear(),
  allTimeBalance: 0,
  unitDebts: {},
  pendingReceipt: null
};

// ---------- Firestore helpers ----------
async function loadSettings() {
  const ref = doc(db, "settings", BUILDING_ID);
  const snap = await getDoc(ref);
  if (snap.exists()) STATE.settings = { ...STATE.settings, ...snap.data() };
}
async function saveSettings(patch) {
  const ref = doc(db, "settings", BUILDING_ID);
  await setDoc(ref, { ...STATE.settings, ...patch }, { merge: true });
  STATE.settings = { ...STATE.settings, ...patch };
}
async function loadUnits() {
  const snap = await getDocs(collection(db, "units"));
  if (snap.empty) {
    // seed empty units 1..TOTAL_UNITS on first run (original units, active since 2023)
    for (let i = 1; i <= TOTAL_UNITS; i++) {
      await setDoc(doc(db, "units", String(i)), {
        number: i, currentName: "", currentPhone: "", pin: "", history: [],
        createdYear: 2023, manualDebtAdjustment: 0
      });
    }
    return loadUnits();
  }
  STATE.units = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a,b) => a.number - b.number);
}
async function addUnit() {
  const nextNum = STATE.units.length ? Math.max(...STATE.units.map(u => u.number)) + 1 : 1;
  const unitId = String(nextNum);
  const createdYear = new Date().getFullYear();
  await setDoc(doc(db, "units", unitId), {
    number: nextNum, currentName: "", currentPhone: "", pin: "", history: [],
    createdYear, manualDebtAdjustment: 0
  });
  STATE.units.push({ id: unitId, number: nextNum, currentName: "", currentPhone: "", pin: "", history: [], createdYear, manualDebtAdjustment: 0 });
}
function getUnitCumulative(unitId) {
  return STATE.unitDebts[unitId] || { paid: 0, expected: 0, adjustment: 0, debt: 0 };
}
async function loadTransactions(year) {
  const q = query(collection(db, "transactions"), where("year", "==", year));
  const snap = await getDocs(q);
  STATE.transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function computeAllTimeBalance() {
  const snap = await getDocs(collection(db, "transactions"));
  let income = 0, expense = 0;
  const paidByUnit = {};
  snap.docs.forEach(d => {
    const t = d.data();
    if (t.type === "income") {
      income += (t.amount||0);
      if (t.unitId) paidByUnit[t.unitId] = (paidByUnit[t.unitId]||0) + (t.amount||0);
    } else {
      expense += (t.amount||0);
    }
  });
  STATE.allTimeBalance = income - expense;
  const nowYear = new Date().getFullYear();
  STATE.unitDebts = {};
  STATE.units.forEach(u => {
    const startYear = u.createdYear || 2023;
    const yearsActive = Math.max(1, nowYear - startYear + 1);
    const expected = STATE.settings.fee * 12 * yearsActive;
    const paid = paidByUnit[u.id] || 0;
    const adjustment = u.manualDebtAdjustment || 0;
    STATE.unitDebts[u.id] = { paid, expected, adjustment, debt: expected - paid + adjustment };
  });
  return STATE.allTimeBalance;
}
async function saveTransaction(tx) {
  const ref = await addDoc(collection(db, "transactions"), tx);
  STATE.transactions.push({ id: ref.id, ...tx });
  STATE.allTimeBalance += (tx.type === "income" ? tx.amount : -tx.amount);
  return ref.id;
}
async function updateUnit(unitId, patch) {
  await updateDoc(doc(db, "units", unitId), patch);
  const u = STATE.units.find(x => x.id === unitId);
  if (u) Object.assign(u, patch);
}

// ---------- Routing ----------
function showView(id) {
  document.querySelectorAll("main > section").forEach(s => s.classList.add("hidden"));
  $(id).classList.remove("hidden");
  document.querySelectorAll("#admin-tabbar button").forEach(b => {
    b.classList.toggle("active", b.dataset.view === id);
  });
  window.scrollTo(0,0);
  if (id === "view-dashboard") renderDashboard();
  if (id === "view-units") renderUnitsGrid("units-grid-full");
  if (id === "view-add-income") renderAddIncome();
  if (id === "view-add-expense") renderAddExpense();
  if (id === "view-reports") {
    document.querySelectorAll("[data-range]").forEach(x => x.classList.remove("tab-active"));
    document.querySelector('[data-range="month"]').classList.add("tab-active");
    currentReportRange = "month";
    renderReports("month");
  }
  if (id === "view-projects") renderProjects();
  if (id === "view-settings") renderSettings();
  if (id === "view-resident") renderResidentView();
}

document.querySelectorAll("#admin-tabbar button").forEach(btn => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

// ---------- Auth ----------
$("tab-admin-login").addEventListener("click", () => {
  $("admin-login-form").classList.remove("hidden");
  $("resident-login-form").classList.add("hidden");
  $("tab-admin-login").classList.remove("tab-inactive"); $("tab-admin-login").classList.add("tab-active");
  $("tab-resident-login").classList.remove("tab-active"); $("tab-resident-login").classList.add("tab-inactive");
});
$("tab-resident-login").addEventListener("click", () => {
  $("resident-login-form").classList.remove("hidden");
  $("admin-login-form").classList.add("hidden");
  $("tab-resident-login").classList.remove("tab-inactive"); $("tab-resident-login").classList.add("tab-active");
  $("tab-admin-login").classList.remove("tab-active"); $("tab-admin-login").classList.add("tab-inactive");
  $("resident-unit").innerHTML = STATE.units.map(u =>
    `<option value="${u.id}">דירה ${u.number}${u.currentName ? " · " + u.currentName : ""}</option>`
  ).join("");
});
$("btn-admin-login").addEventListener("click", async () => {
  try {
    await signInWithEmailAndPassword(auth, $("admin-email").value, $("admin-pass").value);
  } catch (e) {
    alert("שגיאת התחברות: " + e.message);
  }
});
$("btn-resident-login").addEventListener("click", () => {
  const unitId = $("resident-unit").value;
  const pin = $("resident-pin").value.trim();
  const unit = STATE.units.find(u => u.id === unitId);
  if (!unit || !unit.pin || unit.pin !== pin) {
    alert("קוד שגוי. פנה לוועד הבית לקבלת קוד אישי.");
    return;
  }
  STATE.role = "resident";
  STATE.residentUnitId = unitId;
  enterApp();
});
$("btn-logout").addEventListener("click", async () => {
  STATE.role = null;
  STATE.residentUnitId = null;
  if (auth.currentUser) await signOut(auth);
  location.reload();
});
$("btn-show-public").addEventListener("click", () => {
  $("view-entry").classList.add("hidden");
  renderPublicView();
  $("view-public").classList.remove("hidden");
});
$("btn-back-entry").addEventListener("click", () => {
  $("view-public").classList.add("hidden");
  $("view-entry").classList.remove("hidden");
});

onAuthStateChanged(auth, async (user) => {
  await loadSettings();
  await loadUnits();
  if (user) {
    STATE.role = "admin";
    await enterApp();
  } else if (STATE.role !== "resident") {
    $("hdr-sub").textContent = STATE.settings.name;
  }
});

async function enterApp() {
  $("hdr-title").textContent = STATE.settings.name || "ניהול ועד";
  $("hdr-sub").textContent = STATE.settings.address || "";
  await loadTransactions(STATE.currentYear);
  $("view-entry").classList.add("hidden");
  $("view-public").classList.add("hidden");
  if (STATE.role === "admin") {
    await computeAllTimeBalance();
    populateYearSelector();
    $("admin-tabbar").classList.remove("hidden");
    showView("view-dashboard");
  } else {
    $("admin-tabbar").classList.add("hidden");
    showView("view-resident");
  }
}
function populateYearSelector() {
  const realYear = new Date().getFullYear();
  const earliestYear = 2023;
  const years = [];
  for (let y = realYear + 1; y >= earliestYear; y--) years.push(y);
  $("dash-year-select").innerHTML = years.map(y =>
    `<option value="${y}" ${y===STATE.currentYear?"selected":""}>${y === realYear ? "שנה נוכחית · " : ""}${y}</option>`).join("");
  $("dash-year-select").onchange = async () => {
    STATE.currentYear = parseInt($("dash-year-select").value);
    await loadTransactions(STATE.currentYear);
    renderDashboard();
  };
}

// ---------- Derived data ----------
function unitStatus(unit) {
  const cum = getUnitCumulative(unit.id);
  const isVacant = !unit.currentName;
  const turnover = (unit.history||[]).some(h => h.endDate && h.endDate.includes(String(STATE.currentYear)));
  let status = "paid";
  if (isVacant) status = "vacant";
  else if (cum.debt > 0) status = "late";
  return { ...cum, isVacant, turnover, status };
}

function unitCardHtml(unit, forDashboard) {
  const st = unitStatus(unit);
  const label = st.isVacant ? "ריקה" : (st.status === "paid" ? "אין חוב" : `חוב מצטבר: ${fmtILS(st.debt)}`);
  return `
  <div class="unit-card ${st.turnover ? "turnover" : ""}" data-unit="${unit.id}">
    <div class="row-top">
      <p class="num">דירה ${unit.number}</p>
      <span class="dot ${st.status}"></span>
    </div>
    <p class="name">${unit.currentName || "ריקה"}</p>
    ${st.turnover ? `<p class="turnover-tag"><i class="ti ti-refresh"></i> הוחלף דייר</p>` : ""}
    <p class="status-text ${st.status}">${label}</p>
  </div>`;
}

function renderUnitsGrid(containerId) {
  $(containerId).innerHTML = STATE.units.map(u => unitCardHtml(u)).join("");
  $(containerId).querySelectorAll(".unit-card").forEach(el => {
    el.addEventListener("click", () => openUnitDetail(el.dataset.unit));
  });
}

function renderDashboard() {
  const income = STATE.transactions.filter(t=>t.type==="income").reduce((s,t)=>s+(t.amount||0),0);
  const expense = STATE.transactions.filter(t=>t.type==="expense").reduce((s,t)=>s+(t.amount||0),0);
  $("d-income").textContent = fmtILS(income);
  $("d-expense").textContent = fmtILS(expense);
  $("d-balance").textContent = fmtILS(STATE.allTimeBalance);
  renderUnitsGrid("dashboard-units");
}

async function openUnitDetail(unitId) {
  const unit = STATE.units.find(u => u.id === unitId);
  $("ud-title").textContent = `דירה ${unit.number}`;
  $("ud-sub").textContent = unit.currentName ? `דייר נוכחי: ${unit.currentName}` : "דירה ריקה";
  const hist = (unit.history||[]).slice().reverse();
  $("ud-tenant-history").innerHTML = hist.length ? hist.map(h => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-top:1px solid var(--border);">
      <span>${h.name}</span><span style="color:var(--text-secondary);">${h.startDate||""} — ${h.endDate||"היום"}</span>
    </div>`).join("") : `<p style="font-size:12px;color:var(--text-muted);">אין היסטוריית דיירים קודמים</p>`;

  showViewRaw("view-unit-detail");
  renderUnitCumulativeCard(unitId);

  const txs = STATE.transactions.filter(t => t.unitId === unitId).sort((a,b)=>b.date.localeCompare(a.date));
  $("ud-transactions").innerHTML = txs.length ? txs.map(t => `
    <div class="card" style="padding:10px 14px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;">
        <span style="font-size:13px;">${t.category||"דמי ועד"}</span>
        <span style="font-size:13px;font-weight:700;">${fmtILS(t.amount)}</span>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin:2px 0 0;">${t.date}</p>
    </div>`).join("") : `<p class="center-note">אין תנועות עדיין בשנה הנוכחית שנבחרה</p>`;
}
function renderUnitCumulativeCard(unitId) {
  const unit = STATE.units.find(u => u.id === unitId);
  const cum = getUnitCumulative(unitId);
  $("ud-cumulative").innerHTML = `
    <div class="card">
      <p style="font-weight:700;font-size:13px;margin:0 0 8px;">יתרת חוב מצטברת (הערכה, כל השנים)</p>
      <table style="width:100%;font-size:12px;border-collapse:collapse;">
        <tr><td style="color:var(--text-secondary);padding:3px 0;">סה"כ שולם אי-פעם</td><td style="text-align:left;">${fmtILS(cum.paid)}</td></tr>
        <tr><td style="color:var(--text-secondary);padding:3px 0;">צפי (${STATE.settings.fee}₪ × 12 חודשים × שנות פעילות)</td><td style="text-align:left;">${fmtILS(cum.expected)}</td></tr>
        <tr><td style="color:var(--text-secondary);padding:3px 0;">התאמה ידנית</td><td style="text-align:left;">${fmtILS(cum.adjustment)}</td></tr>
        <tr style="border-top:1px solid var(--border-strong);"><td style="padding:6px 0 0;font-weight:700;">יתרת חוב</td><td style="text-align:left;padding:6px 0 0;font-weight:700;color:${cum.debt>0?"var(--red)":"var(--green)"};">${fmtILS(cum.debt)}</td></tr>
      </table>
      <p style="font-size:11px;color:var(--text-muted);margin:8px 0 10px;">זו הערכה שמניחה 12 חודשי תשלום בכל שנה מאז שהדירה נוצרה במערכת (${unit.createdYear||2023}). אם הדירה הייתה ריקה חלק מהזמן, השתמש ב"התאמה ידנית" (מספר שלילי מקטין את החוב) כדי לתקן.</p>
      <button class="btn ghost" id="btn-edit-debt-adj">ערוך התאמה ידנית</button>
    </div>`;
  $("btn-edit-debt-adj").addEventListener("click", async () => {
    const val = prompt("התאמה ידנית ליתרת החוב (מספר שלילי = מקטין חוב, למשל בגלל תקופת ריקנות):", String(unit.manualDebtAdjustment||0));
    if (val === null) return;
    const num = parseFloat(val);
    if (isNaN(num)) { alert("יש להזין מספר"); return; }
    await updateUnit(unitId, { manualDebtAdjustment: num });
    STATE.unitDebts[unitId].adjustment = num;
    STATE.unitDebts[unitId].debt = STATE.unitDebts[unitId].expected - STATE.unitDebts[unitId].paid + num;
    renderUnitCumulativeCard(unitId);
    renderUnitsGrid("dashboard-units");
  });
}
function showViewRaw(id) {
  document.querySelectorAll("main > section").forEach(s => s.classList.add("hidden"));
  $(id).classList.remove("hidden");
  window.scrollTo(0,0);
}

// ---------- Add income ----------
function renderAddIncome() {
  $("inc-unit").innerHTML = STATE.units.map(u =>
    `<option value="${u.id}">דירה ${u.number} · ${u.currentName || "ריקה"}</option>`).join("");
  const grid = $("inc-months-grid");
  grid.innerHTML = HEB_MONTHS.slice(0,4).map((m,i) => "").join(""); // placeholder cleared below
  const monthChips = HEB_MONTHS.map((m,i) => `<div class="chip" data-m="${i}">${m.slice(0,3)}</div>`).join("");
  grid.innerHTML = monthChips;
  grid.querySelectorAll(".chip").forEach(c => c.addEventListener("click", () => {
    c.classList.toggle("selected");
    updateIncomeAmount();
  }));
  $("inc-date-display").textContent = "היום · " + todayISO().split("-").reverse().join(".");
  updateIncomeAmount();
  $("inc-type").onchange = () => {
    $("inc-months-block").classList.toggle("hidden", $("inc-type").value !== "monthly");
    updateIncomeAmount();
  };
}
function updateIncomeAmount() {
  const selected = document.querySelectorAll("#inc-months-grid .chip.selected").length;
  const type = $("inc-type").value;
  if (type === "monthly") {
    const total = selected * STATE.settings.fee;
    $("inc-amount").value = total;
    $("inc-amount-hint").textContent = selected ? `${fmtILS(STATE.settings.fee)} × ${selected} חודשים שנבחרו` : "בחר חודשים למעלה";
  } else {
    $("inc-amount-hint").textContent = "";
  }
}
$("btn-save-income").addEventListener("click", async () => {
  const unitId = $("inc-unit").value;
  const type = $("inc-type").value;
  const amount = parseFloat($("inc-amount").value || "0");
  if (!amount) { alert("נא להזין סכום"); return; }
  const selectedMonths = Array.from(document.querySelectorAll("#inc-months-grid .chip.selected")).map(c => parseInt(c.dataset.m));
  const tx = {
    type: "income", unitId,
    category: type === "monthly" ? "דמי ועד" : (type === "culture" ? "תרבות הדיור" : "אחר"),
    amount, months: selectedMonths, method: $("inc-method").value,
    date: todayISO(), note: $("inc-note").value || "",
    year: STATE.currentYear, createdAt: Date.now()
  };
  const id = await saveTransaction(tx);
  if (STATE.unitDebts[unitId]) {
    STATE.unitDebts[unitId].paid += amount;
    STATE.unitDebts[unitId].debt -= amount;
  }
  openReceipt({ ...tx, id });
});

// ---------- Add expense ----------
function renderAddExpense() {
  $("exp-date-display").textContent = "היום · " + todayISO().split("-").reverse().join(".");
}
$("btn-save-expense").addEventListener("click", async () => {
  const amount = parseFloat($("exp-amount").value || "0");
  if (!amount) { alert("נא להזין סכום"); return; }
  const tx = {
    type: "expense", category: $("exp-category").value, amount,
    method: $("exp-method").value, supplier: $("exp-supplier").value,
    desc: $("exp-desc").value, date: todayISO(),
    year: STATE.currentYear, createdAt: Date.now()
  };
  await saveTransaction(tx);
  alert("ההוצאה נשמרה");
  showView("view-dashboard");
});

// ---------- Receipt ----------
function openReceipt(tx) {
  STATE.pendingReceipt = tx;
  const unit = STATE.units.find(u => u.id === tx.unitId);
  $("rc-bname").textContent = STATE.settings.name;
  $("rc-baddr").textContent = STATE.settings.address;
  $("rc-num").textContent = "#" + STATE.currentYear + "-" + tx.id.slice(0,4).toUpperCase();
  $("rc-date").textContent = tx.date.split("-").reverse().join(".");
  $("rc-unit").textContent = unit ? unit.number : "";
  $("rc-name").textContent = unit ? unit.currentName : "";
  $("rc-method").textContent = tx.method;
  const lines = tx.months && tx.months.length
    ? tx.months.map(m => `<div class="line-item"><span>${tx.category} · ${HEB_MONTHS[m]} ${STATE.currentYear}</span><span>${fmtILS(STATE.settings.fee)}</span></div>`).join("")
    : `<div class="line-item"><span>${tx.category}</span><span>${fmtILS(tx.amount)}</span></div>`;
  $("rc-lines").innerHTML = lines;
  $("rc-total").textContent = fmtILS(tx.amount);
  $("rc-sent-badge").classList.add("hidden");
  $("btn-share-whatsapp").classList.remove("hidden");
  $("rc-sig-block").classList.remove("hidden");
  $("rc-sig-display").innerHTML = STATE.settings.signatureDataUrl
    ? `<img src="${STATE.settings.signatureDataUrl}" style="max-height:100%;max-width:100%;">`
    : `<span style="font-size:12px;color:var(--text-muted);">אין חתימה שמורה — הוסף בהגדרות</span>`;
  showViewRaw("view-receipt");
}
$("btn-edit-sig").addEventListener("click", () => showView("view-settings"));
$("btn-receipt-done").addEventListener("click", () => showView("view-dashboard"));
$("btn-share-whatsapp").addEventListener("click", async () => {
  const tx = STATE.pendingReceipt;
  const unit = STATE.units.find(u => u.id === tx.unitId);
  const msg = `קבלה מ${STATE.settings.name}\nדירה ${unit.number} · ${unit.currentName}\nסכום: ${fmtILS(tx.amount)}\nתאריך: ${tx.date}\nתודה על התשלום!`;
  const phone = (unit.currentPhone||"").replace(/\D/g,"");
  const url = `https://wa.me/${phone.startsWith("0") ? "972"+phone.slice(1) : phone}?text=${encodeURIComponent(msg)}`;
  window.open(url, "_blank");
  await updateDoc(doc(db, "transactions", tx.id), { sharedWhatsapp: true });
  $("btn-share-whatsapp").classList.add("hidden");
  $("rc-sig-block").classList.add("hidden");
  $("rc-sent-badge").classList.remove("hidden");
});

// ---------- Reports ----------
let repChart = null;
let currentReportRange = "month";
document.querySelectorAll("[data-range]").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("[data-range]").forEach(x => x.classList.remove("tab-active"));
  b.classList.add("tab-active");
  currentReportRange = b.dataset.range;
  renderReports(currentReportRange);
}));

function getRangeDates(range) {
  const now = new Date();
  const y = STATE.currentYear || now.getFullYear();
  const isRealYear = y === now.getFullYear();
  let start, end, label;
  if (range === "month") {
    const m = isRealYear ? now.getMonth() : 0;
    start = new Date(y, m, 1);
    end = new Date(y, m+1, 0);
    label = start.toLocaleDateString("he-IL", {month:"long", year:"numeric"});
  } else if (range === "quarter") {
    const q = isRealYear ? Math.floor(now.getMonth()/3) : 0;
    start = new Date(y, q*3, 1);
    end = new Date(y, q*3+3, 0);
    label = `רבעון ${q+1}, ${y}`;
  } else if (range === "half") {
    const h = isRealYear ? (now.getMonth() < 6 ? 0 : 1) : 0;
    start = new Date(y, h*6, 1);
    end = new Date(y, h*6+6, 0);
    label = h === 0 ? `מחצית ראשונה ${y} (ינואר–יוני)` : `מחצית שנייה ${y} (יולי–דצמבר)`;
  } else if (range === "year") {
    start = new Date(y, 0, 1);
    end = new Date(y, 11, 31);
    label = `שנת ${y}`;
  } else { // custom
    const s = $("custom-start")?.value;
    const e = $("custom-end")?.value;
    if (!s || !e) return null;
    start = new Date(s); end = new Date(e);
    label = `${s.split("-").reverse().join(".")} — ${e.split("-").reverse().join(".")}`;
  }
  return { startISO: start.toISOString().slice(0,10), endISO: end.toISOString().slice(0,10), label };
}

function renderReports(range) {
  if (range === "custom") {
    $("reports-range-picker").innerHTML = `
      <div style="display:flex;gap:8px;align-items:end;margin-bottom:10px;">
        <div style="flex:1;"><label>מתאריך</label><input type="date" id="custom-start"></div>
        <div style="flex:1;"><label>עד תאריך</label><input type="date" id="custom-end"></div>
      </div>
      <button class="btn primary" id="btn-apply-custom" style="margin-bottom:14px;">הצג דוח</button>`;
    $("btn-apply-custom").addEventListener("click", () => renderReports("custom"));
    const rd = getRangeDates("custom");
    if (!rd) { $("rep-range-text").textContent = "בחר טווח תאריכים ולחץ \"הצג דוח\""; return; }
    return buildReport(rd);
  }
  $("reports-range-picker").innerHTML = "";
  const rd = getRangeDates(range);
  buildReport(rd);
}

function buildReport(rd) {
  const txs = STATE.transactions.filter(t => t.date >= rd.startISO && t.date <= rd.endISO);
  $("rep-range-text").textContent = `טווח: ${rd.label} (${rd.startISO.split("-").reverse().join(".")} – ${rd.endISO.split("-").reverse().join(".")})`;
  const income = txs.filter(t=>t.type==="income").reduce((s,t)=>s+t.amount,0);
  const expense = txs.filter(t=>t.type==="expense").reduce((s,t)=>s+t.amount,0);
  $("rep-income").textContent = fmtILS(income);
  $("rep-expense").textContent = fmtILS(expense);
  $("rep-balance").textContent = fmtILS(income-expense);
  const byCat = {};
  txs.filter(t=>t.type==="expense").forEach(t => byCat[t.category] = (byCat[t.category]||0) + t.amount);
  const labels = Object.keys(byCat), data = Object.values(byCat);
  const colors = ["#2a78d6","#1baf7a","#eda100","#e34948","#4a3aa7","#e87ba4","#eb6834"];
  if (repChart) repChart.destroy();
  if (labels.length) {
    repChart = new Chart($("rep-chart"), {
      type: "doughnut",
      data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: "#fff", borderWidth: 2 }] },
      options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}} }
    });
  }
  $("rep-legend").innerHTML = labels.length ? labels.map((l,i) => `
    <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:${colors[i%colors.length]};"></span>${l} ${fmtILS(data[i])}</span>`).join("")
    : `<p class="center-note">אין הוצאות בטווח זה</p>`;

  const expenseTxs = txs.filter(t => t.type === "expense").sort((a,b) => b.date.localeCompare(a.date));
  $("rep-expense-list").innerHTML = expenseTxs.length ? expenseTxs.map(t => `
    <div class="card" style="padding:10px 14px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:start;">
        <div>
          <p style="font-size:13px;font-weight:600;margin:0;">${t.category}</p>
          <p style="font-size:11px;color:var(--text-secondary);margin:2px 0 0;">${[t.supplier, t.desc].filter(Boolean).join(" · ") || "—"}</p>
        </div>
        <div style="text-align:left;">
          <p style="font-size:14px;font-weight:700;margin:0;">${fmtILS(t.amount)}</p>
          <p style="font-size:11px;color:var(--text-muted);margin:2px 0 0;">${t.date.split("-").reverse().join(".")} · ${t.method||""}</p>
        </div>
      </div>
    </div>`).join("") : `<p class="center-note">אין הוצאות בטווח זה</p>`;
}
$("btn-export-report").addEventListener("click", () => {
  const rows = [["סוג","קטגוריה/דירה","סכום","תאריך","אופן תשלום"]];
  STATE.transactions.forEach(t => rows.push([
    t.type==="income"?"הכנסה":"הוצאה", t.type==="income"?("דירה "+(STATE.units.find(u=>u.id===t.unitId)||{}).number):t.category,
    t.amount, t.date, t.method
  ]));
  const csv = rows.map(r => r.join(",")).join("\n");
  const blob = new Blob(["\uFEFF"+csv], {type:"text/csv"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `דוח-${STATE.currentYear}.csv`;
  a.click();
});

// ---------- Projects ----------
async function renderProjects() {
  const snap = await getDocs(collection(db, "projects"));
  const list = snap.docs.map(d => ({id:d.id, ...d.data()}));
  $("projects-list").innerHTML = list.length ? list.map(p => `
    <div class="card">
      <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
        <p style="font-weight:700;font-size:14px;margin:0;">${p.title}</p>
        <span class="badge warning">${p.status||"בבחינה"}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        ${(p.quotes||[]).map(q => `
          <div style="background:var(--surface-2);border-radius:8px;padding:10px;">
            <p style="font-size:12px;font-weight:700;margin:0 0 6px;">${q.name}</p>
            <p style="font-size:14px;font-weight:700;margin:0;">${fmtILS(q.total)}</p>
          </div>`).join("")}
      </div>
    </div>`).join("") : `<p class="center-note">אין פרויקטים עדיין</p>`;
}
$("btn-new-project").addEventListener("click", async () => {
  const title = prompt("שם הפרויקט:");
  if (!title) return;
  await addDoc(collection(db, "projects"), { title, quotes: [], status: "בבחינה" });
  renderProjects();
});

// ---------- Settings ----------
let sigCtx, drawing = false;
function renderSettings() {
  $("set-name").value = STATE.settings.name || "";
  $("set-address").value = STATE.settings.address || "";
  $("set-fee").value = STATE.settings.fee || 80;
  renderImportCard();
  const canvas = $("sig-pad");
  sigCtx = canvas.getContext("2d");
  sigCtx.clearRect(0,0,canvas.width,canvas.height);
  sigCtx.lineWidth = 2; sigCtx.strokeStyle = "#1c2733";
  canvas.onpointerdown = (e) => { drawing = true; sigCtx.beginPath(); sigCtx.moveTo(e.offsetX, e.offsetY); };
  canvas.onpointermove = (e) => { if (drawing) { sigCtx.lineTo(e.offsetX, e.offsetY); sigCtx.stroke(); } };
  canvas.onpointerup = () => drawing = false;
  $("settings-units-list").innerHTML = STATE.units.map(u => `
    <div class="card" style="padding:10px 14px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <p style="font-weight:700;font-size:13px;margin:0;">דירה ${u.number}</p>
        <button class="btn ghost" style="width:auto;padding:4px 10px;font-size:11px;" data-edit="${u.id}">ערוך</button>
      </div>
      <p style="font-size:12px;color:var(--text-secondary);margin:4px 0 0;">${u.currentName || "ריקה"} ${u.currentPhone ? "· "+u.currentPhone : ""}</p>
    </div>`).join("");
  $("settings-units-list").querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => editUnit(btn.dataset.edit));
  });
}
$("btn-clear-sig").addEventListener("click", () => sigCtx.clearRect(0,0,$("sig-pad").width,$("sig-pad").height));
$("btn-save-sig").addEventListener("click", async () => {
  const dataUrl = $("sig-pad").toDataURL("image/png");
  await saveSettings({ signatureDataUrl: dataUrl });
  alert("החתימה נשמרה");
});
$("btn-save-settings").addEventListener("click", async () => {
  await saveSettings({
    name: $("set-name").value, address: $("set-address").value,
    fee: parseFloat($("set-fee").value || "80")
  });
  $("hdr-title").textContent = STATE.settings.name;
  $("hdr-sub").textContent = STATE.settings.address;
  alert("ההגדרות נשמרו");
});
$("btn-add-unit").addEventListener("click", async () => {
  await addUnit();
  renderSettings();
  alert("דירה חדשה נוספה. אפשר לערוך שם דייר, טלפון ו-PIN בכרטיס שלה למטה.");
});
async function editUnit(unitId) {
  const unit = STATE.units.find(u => u.id === unitId);
  const newName = prompt("שם הדייר הנוכחי (השאר ריק אם הדירה ריקה):", unit.currentName || "");
  if (newName === null) return;
  const newPhone = prompt("מספר טלפון (לשיתוף קבלות בוואטסאפ):", unit.currentPhone || "") || "";
  const newPin = prompt("קוד PIN אישי לדייר (4 ספרות):", unit.pin || "") || "";
  let history = unit.history || [];
  if (newName !== unit.currentName) {
    if (unit.currentName) {
      history = [...history, { name: unit.currentName, phone: unit.currentPhone, startDate: unit.moveInDate || "", endDate: todayISO() }];
    }
  }
  await updateUnit(unitId, { currentName: newName, currentPhone: newPhone, pin: newPin, history, moveInDate: newName !== unit.currentName ? todayISO() : (unit.moveInDate||"") });
  renderSettings();
}

// ---------- Historical data import ----------
function renderImportCard() {
  const incCount = historicalData.income.length;
  const expCount = historicalData.expense.length;
  const incSum = historicalData.income.reduce((s,x)=>s+x.amount,0);
  const expSum = historicalData.expense.reduce((s,x)=>s+x.amount,0);
  $("import-summary").textContent =
    `${incCount} רשומות הכנסה (סה"כ ${fmtILS(incSum)}) + ${expCount} רשומות הוצאה (סה"כ ${fmtILS(expSum)}), שנים 2023–2026.`;
  $("import-done-note").classList.toggle("hidden", !STATE.settings.historicalImported);
  $("btn-import-history").textContent = STATE.settings.historicalImported
    ? "ייבא שוב (עלול ליצור כפילויות!)" : "ייבא נתונים היסטוריים (2023–2026)";
}
$("btn-import-history").addEventListener("click", async () => {
  const ok = confirm(
    `הפעולה תוסיף ${historicalData.income.length} תנועות הכנסה ו-${historicalData.expense.length} תנועות הוצאה, ` +
    `ותעדכן היסטוריית דיירים ל-12 הדירות. זו פעולה חד-פעמית מומלצת. להמשיך?`
  );
  if (!ok) return;
  $("btn-import-history").disabled = true;
  $("btn-import-history").textContent = "מייבא... נא לא לסגור את הדף";
  try {
    // batched writes, max ~450 ops per batch
    const allTx = [
      ...historicalData.income.map(x => ({
        type: "income", unitId: String(x.unit), category: x.category, amount: x.amount,
        months: x.month !== null && x.month !== undefined ? [x.month] : [],
        method: x.method, date: x.date, note: x.note, year: x.year, createdAt: Date.now()
      })),
      ...historicalData.expense.map(x => ({
        type: "expense", category: x.category, amount: x.amount, method: x.method,
        supplier: x.desc || "", desc: x.note, date: x.date, year: x.year, createdAt: Date.now()
      }))
    ];
    for (let i = 0; i < allTx.length; i += 400) {
      const batch = writeBatch(db);
      const chunk = allTx.slice(i, i + 400);
      chunk.forEach(tx => {
        const ref = doc(collection(db, "transactions"));
        batch.set(ref, tx);
      });
      await batch.commit();
    }
    // update unit history
    for (const [unitNum, info] of Object.entries(historicalData.unitsHistory)) {
      const unitId = String(unitNum);
      const existing = STATE.units.find(u => u.id === unitId);
      if (!existing) continue;
      const mergedHistory = [
        ...(existing.history || []),
        ...info.history.map(h => ({ name: h.name, startDate: "", endDate: h.note }))
      ];
      await updateUnit(unitId, { history: mergedHistory });
    }
    // add renovation quotes project
    await addDoc(collection(db, "projects"), historicalData.quotesProject);
    await saveSettings({ historicalImported: true });
    if (STATE.currentYear) await loadTransactions(STATE.currentYear);
    await computeAllTimeBalance();
    alert("הייבוא הושלם בהצלחה!");
  } catch (e) {
    alert("שגיאה בייבוא: " + e.message);
  } finally {
    $("btn-import-history").disabled = false;
    renderImportCard();
  }
});

// ---------- Public view ----------
async function renderPublicView() {
  await loadSettings();
  await loadUnits();
  const year = new Date().getFullYear();
  const q = query(collection(db, "transactions"), where("year", "==", year));
  const snap = await getDocs(q);
  const txs = snap.docs.map(d => d.data());
  const income = txs.filter(t=>t.type==="income").reduce((s,t)=>s+t.amount,0);
  const expense = txs.filter(t=>t.type==="expense").reduce((s,t)=>s+t.amount,0);
  const allTimeSnap = await getDocs(collection(db, "transactions"));
  let allIncome = 0, allExpense = 0;
  allTimeSnap.docs.forEach(d => {
    const t = d.data();
    if (t.type === "income") allIncome += (t.amount||0); else allExpense += (t.amount||0);
  });
  $("pub-bname").textContent = STATE.settings.name;
  $("pub-baddr").textContent = STATE.settings.address;
  $("pub-balance").textContent = fmtILS(allIncome - allExpense);
  $("pub-year").textContent = String(year);
  const total = income+expense || 1;
  $("pub-bar-income").style.width = (income/total*100)+"%";
  $("pub-bar-expense").style.width = (expense/total*100)+"%";
  $("pub-income-txt").textContent = "הכנסות " + fmtILS(income);
  $("pub-expense-txt").textContent = "הוצאות " + fmtILS(expense);
}

// ---------- Resident view ----------
function renderResidentView() {
  const unit = STATE.units.find(u => u.id === STATE.residentUnitId);
  const st = unitStatus(unit);
  $("res-unit-num").textContent = unit.number;
  $("res-balance").textContent = fmtILS(st.debt);
  const txs = STATE.transactions.filter(t => t.unitId === unit.id).sort((a,b)=>b.date.localeCompare(a.date));
  $("res-transactions").innerHTML = txs.length ? txs.map(t => `
    <div class="card" style="padding:10px 14px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;">
        <span style="font-size:13px;">${t.category}</span>
        <span style="font-size:13px;font-weight:700;">${fmtILS(t.amount)}</span>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin:2px 0 0;">${t.date}</p>
    </div>`).join("") : `<p class="center-note">אין תשלומים רשומים עדיין</p>`;
}

// wire dashboard shortcut buttons
$("btn-goto-add-income").addEventListener("click", () => showView("view-add-income"));
$("btn-goto-add-expense").addEventListener("click", () => showView("view-add-expense"));
