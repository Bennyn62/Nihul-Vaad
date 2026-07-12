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
    // seed empty units 1..TOTAL_UNITS on first run
    for (let i = 1; i <= TOTAL_UNITS; i++) {
      await setDoc(doc(db, "units", String(i)), {
        number: i, currentName: "", currentPhone: "", pin: "", history: []
      });
    }
    return loadUnits();
  }
  STATE.units = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a,b) => a.number - b.number);
}
async function loadTransactions(year) {
  const q = query(collection(db, "transactions"), where("year", "==", year));
  const snap = await getDocs(q);
  STATE.transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function saveTransaction(tx) {
  const ref = await addDoc(collection(db, "transactions"), tx);
  STATE.transactions.push({ id: ref.id, ...tx });
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
  if (id === "view-reports") renderReports("month");
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
});
$("tab-resident-login").addEventListener("click", () => {
  $("resident-login-form").classList.remove("hidden");
  $("admin-login-form").classList.add("hidden");
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
    $("admin-tabbar").classList.remove("hidden");
    showView("view-dashboard");
  } else {
    $("admin-tabbar").classList.add("hidden");
    showView("view-resident");
  }
}

// ---------- Derived data ----------
function unitStatus(unit) {
  const paid = STATE.transactions
    .filter(t => t.type === "income" && t.unitId === unit.id)
    .reduce((s,t) => s + (t.amount||0), 0);
  const expected = STATE.settings.fee * 12;
  const isVacant = !unit.currentName;
  const turnover = (unit.history||[]).some(h => h.endDate && h.endDate.startsWith(String(STATE.currentYear)));
  let status = "paid";
  if (isVacant) status = "vacant";
  else if (paid < expected) status = "late";
  return { paid, expected, isVacant, turnover, status };
}

function unitCardHtml(unit, forDashboard) {
  const st = unitStatus(unit);
  const label = st.isVacant ? "ריקה" : (st.status === "paid" ? "שולם במלואו" : `שולם ${fmtILS(st.paid)} מ-${fmtILS(st.expected)}`);
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
  $("d-balance").textContent = fmtILS(income - expense);
  renderUnitsGrid("dashboard-units");
}

function openUnitDetail(unitId) {
  const unit = STATE.units.find(u => u.id === unitId);
  $("ud-title").textContent = `דירה ${unit.number}`;
  $("ud-sub").textContent = unit.currentName ? `דייר נוכחי: ${unit.currentName}` : "דירה ריקה";
  const hist = (unit.history||[]).slice().reverse();
  $("ud-tenant-history").innerHTML = hist.length ? hist.map(h => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-top:1px solid var(--border);">
      <span>${h.name}</span><span style="color:var(--text-secondary);">${h.startDate||""} — ${h.endDate||"היום"}</span>
    </div>`).join("") : `<p style="font-size:12px;color:var(--text-muted);">אין היסטוריית דיירים קודמים</p>`;
  const txs = STATE.transactions.filter(t => t.unitId === unitId).sort((a,b)=>b.date.localeCompare(a.date));
  $("ud-transactions").innerHTML = txs.length ? txs.map(t => `
    <div class="card" style="padding:10px 14px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;">
        <span style="font-size:13px;">${t.category||"דמי ועד"}</span>
        <span style="font-size:13px;font-weight:700;">${fmtILS(t.amount)}</span>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin:2px 0 0;">${t.date}</p>
    </div>`).join("") : `<p class="center-note">אין תנועות עדיין השנה</p>`;
  showViewRaw("view-unit-detail");
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
document.querySelectorAll("[data-range]").forEach(b => b.addEventListener("click", () => renderReports(b.dataset.range)));
function renderReports(range) {
  let txs = STATE.transactions;
  if (range === "month") {
    const m = String(new Date().getMonth()+1).padStart(2,"0");
    txs = txs.filter(t => t.date.slice(5,7) === m);
  } else if (range === "quarter") {
    const q = Math.floor(new Date().getMonth()/3);
    txs = txs.filter(t => Math.floor((parseInt(t.date.slice(5,7))-1)/3) === q);
  }
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
  repChart = new Chart($("rep-chart"), {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: "#fff", borderWidth: 2 }] },
    options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}} }
  });
  $("rep-legend").innerHTML = labels.map((l,i) => `
    <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:${colors[i%colors.length]};"></span>${l} ${fmtILS(data[i])}</span>`).join("");
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
  $("pub-bname").textContent = STATE.settings.name;
  $("pub-baddr").textContent = STATE.settings.address;
  $("pub-balance").textContent = fmtILS(income-expense);
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
  $("res-balance").textContent = fmtILS(st.expected - st.paid);
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
