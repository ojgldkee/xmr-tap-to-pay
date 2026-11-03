const FEE_RATE = 0.01;
const DEFAULT_QUOTE = 623.23;
const STORAGE = {
  invoices: 'xmrtap.invoices.v2',
  settings: 'xmrtap.settings.v2',
  legacySettings: 'xmrtap.settings.v1',
  merchantKey: 'xmrtap.merchantKey.v1',
  demoWalletKeys: 'xmrtap.demoWalletKeys.v1'
};

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

const legacySettings = loadJson(STORAGE.legacySettings, {});
const savedSettings = loadJson(STORAGE.settings, {});
const legacyInvoices = loadJson('xmrtap.invoices.v1', []);
const state = {
  quote: DEFAULT_QUOTE,
  quoteSource: 'fallback',
  invoices: loadJson(STORAGE.invoices, legacyInvoices),
  settings: {
    merchantName: savedSettings.merchantName || legacySettings.merchantName || 'Demo Merchant',
    backendUrl: savedSettings.backendUrl || legacySettings.backendUrl || '',
    profileImage: savedSettings.profileImage || '',
    payoutConfirmed: Boolean(savedSettings.payoutConfirmed),
    payoutMasked: savedSettings.payoutMasked || '',
    backendManagedPayout: Boolean(savedSettings.backendManagedPayout)
  },
  pendingPayoutAddress: '',
  activeInvoiceId: null,
  refundInvoiceId: null,
  detailInvoiceId: null,
  merchantKeyPair: null,
  paymentPollTimer: null,
  backendHealth: null,
  accessToken: sessionStorage.getItem('xmrtap.accessToken') || ''
};

const $ = id => document.getElementById(id);
const fmtUsd = n => new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(Number(n || 0));
const fmtXmr = n => `${Number(n || 0).toFixed(6)} XMR`;
const fmtDate = iso => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString([], { dateStyle:'medium', timeStyle:'short' }); } catch { return iso; }
};
const nowIso = () => new Date().toISOString();

function randomHex(bytes=16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2,'0')).join('');
}
function base64Url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function shortId(prefix='XRT') { return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomHex(3).toUpperCase()}`; }
function atomicUnits(xmr) { return Math.round(Number(xmr) * 1e12); }
function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function shorten(value, head=12, tail=8) {
  const s = String(value || '');
  if (s.length <= head + tail + 3) return s || '—';
  return `${s.slice(0,head)}…${s.slice(-tail)}`;
}
function maskAddress(address) {
  const s = String(address || '').trim();
  if (!s) return '';
  return `${s.slice(0,8)}••••••••${s.slice(-8)}`;
}
function validMoneroAddress(address) {
  const a = String(address || '').trim();
  return [95,106].includes(a.length) && ['4','8'].includes(a[0]) && /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(a);
}
function makeDemoAddress() {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes = new Uint8Array(94);
  crypto.getRandomValues(bytes);
  return '8' + [...bytes].map(b => alphabet[b % alphabet.length]).join('');
}
function merchantInitial() {
  return (state.settings.merchantName || 'M').trim().charAt(0).toUpperCase() || 'M';
}
function authHeaders(extra={}) {
  const headers = { ...extra };
  if (state.accessToken) headers['X-XMR-Tap-Token'] = state.accessToken;
  return headers;
}

function setAvatar(el, image) {
  if (!el) return;
  if (image) {
    el.style.backgroundImage = `url("${image.replace(/"/g,'%22')}")`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.textContent = merchantInitial();
  }
}

async function resizeProfileImage(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > 8 * 1024 * 1024) throw new Error('Profile image must be under 8 MB.');

  const dataUrl = await new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve,reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });

  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const scale = Math.max(size / img.width, size / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (size-w)/2, (size-h)/2, w, h);
  return canvas.toDataURL('image/webp', .82);
}

async function getMerchantKeyPair() {
  if (state.merchantKeyPair) return state.merchantKeyPair;
  const stored = loadJson(STORAGE.merchantKey, null);
  if (stored?.privateKey && stored?.publicKey) {
    try {
      const privateKey = await crypto.subtle.importKey('jwk', stored.privateKey, {name:'ECDSA',namedCurve:'P-256'}, true, ['sign']);
      const publicKey = await crypto.subtle.importKey('jwk', stored.publicKey, {name:'ECDSA',namedCurve:'P-256'}, true, ['verify']);
      state.merchantKeyPair = { privateKey, publicKey };
      return state.merchantKeyPair;
    } catch {}
  }
  const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, true, ['sign','verify']);
  saveJson(STORAGE.merchantKey, {
    privateKey:await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicKey:await crypto.subtle.exportKey('jwk', pair.publicKey)
  });
  state.merchantKeyPair = pair;
  return pair;
}

async function signReceipt(receiptCore) {
  const pair = await getMerchantKeyPair();
  const data = new TextEncoder().encode(JSON.stringify(receiptCore));
  const signature = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'}, pair.privateKey, data);
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { ...receiptCore, signature:base64Url(signature), merchantReceiptPublicKey:publicKey };
}

async function generateDemoCustomerCredential(invoiceId) {
  const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, true, ['sign','verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const all = loadJson(STORAGE.demoWalletKeys, {});
  all[invoiceId] = { publicKey, privateKey };
  saveJson(STORAGE.demoWalletKeys, all);
  return publicKey;
}

async function apiHealth() {
  const base = state.settings.backendUrl?.trim();
  if (!base) return null;
  try {
    const r = await fetch(`${base.replace(/\/$/,'')}/api/health`, {
      headers:{'Cache-Control':'no-store'},
      referrerPolicy:'no-referrer'
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data?.ok ? data : null;
  } catch { return null; }
}

async function refreshBackendState() {
  state.backendHealth = await apiHealth();
  return state.backendHealth;
}

async function refreshQuote() {
  const status = $('quoteStatus');
  const base = state.settings.backendUrl?.trim();
  if (base) {
    try {
      const r = await fetch(`${base.replace(/\/$/,'')}/api/quote`, { cache:'no-store', referrerPolicy:'no-referrer' });
      if (!r.ok) throw new Error('quote unavailable');
      const data = await r.json();
      if (!data?.usdPerXmr) throw new Error('missing quote');
      state.quote = Number(data.usdPerXmr);
      state.quoteSource = data.source || 'private proxy';
      status.textContent = 'Private server quote';
      $('xmrQuote').textContent = fmtUsd(state.quote);
      updateSaleSummary();
      updateRefundSummary();
      return;
    } catch {}
  }

  state.quote = DEFAULT_QUOTE;
  state.quoteSource = 'fallback';
  status.textContent = 'Demo fallback quote';
  $('xmrQuote').textContent = fmtUsd(state.quote);
  updateSaleSummary();
  updateRefundSummary();
}

function profileReady() {
  return Boolean((state.settings.merchantName || '').trim());
}
function setupReady() {
  return profileReady() && state.settings.payoutConfirmed;
}
function renderMerchantIdentity() {
  $('merchantNameHeader').textContent = state.settings.merchantName || 'Merchant setup';
  $('customerMerchantName').textContent = state.settings.merchantName || 'Merchant';
  $('paymentCustomerMerchantName').textContent = state.settings.merchantName || 'Merchant';
  setAvatar($('headerAvatar'), state.settings.profileImage);
  setAvatar($('profilePreview'), state.settings.profileImage);
  setAvatar($('customerAvatar'), state.settings.profileImage);
  setAvatar($('paymentCustomerAvatar'), state.settings.profileImage);
}

function renderSetupState() {
  const ready = setupReady();
  $('setupGate').classList.toggle('hidden', ready);
  $('saleGrid').classList.toggle('hidden', !ready);

  $('setupStepProfile').classList.toggle('complete', profileReady());
  $('setupStepWallet').classList.toggle('complete', state.settings.payoutConfirmed);
  $('setupStepReady').classList.toggle('complete', ready);

  $('walletUnconfigured').classList.toggle('hidden', state.settings.payoutConfirmed);
  $('walletConfigured').classList.toggle('hidden', !state.settings.payoutConfirmed);
  $('payoutSetupBadge').classList.toggle('ready', state.settings.payoutConfirmed);
  $('payoutSetupBadge').textContent = state.settings.payoutConfirmed ? 'Confirmed' : 'Not configured';
  $('maskedWalletAddress').textContent = state.settings.payoutMasked || 'Private payout wallet';

  if (!ready) {
    $('modeLabel').textContent = 'Setup required';
  }
}

async function updateModeLabel() {
  const health = await refreshBackendState();
  if (!setupReady()) return renderSetupState();

  if (health?.mode === 'rpc') $('modeLabel').textContent = 'Private Wallet RPC connected';
  else if (health?.secureConfigReady) $('modeLabel').textContent = 'Private payout configured';
  else $('modeLabel').textContent = 'Demo setup · backend required';
}

function setView(name) {
  document.querySelectorAll('.nav-item').forEach(btn => btn.classList.toggle('active', btn.dataset.view === name));
  document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
  $(`${name}View`).classList.add('active');
  const titles = { sale:'New sale', activity:'Activity', refunds:'Refunds', settings:'Settings' };
  $('viewTitle').textContent = titles[name];
  if (name === 'activity') renderActivity();
  if (name === 'settings') {
    $('merchantNameInput').value = state.settings.merchantName || '';
    $('backendUrlInput').value = state.settings.backendUrl || '';
    renderSetupState();
  }
}

function saleAmount() {
  const raw = $('saleAmount').value.trim().replace(/[^0-9.]/g,'');
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function updateSaleSummary() {
  const amount = saleAmount();
  const xmr = amount && state.quote ? amount / state.quote : 0;
  $('customerPays').textContent = fmtUsd(amount);
  $('customerXmr').textContent = fmtXmr(xmr);
  $('platformFee').textContent = fmtUsd(amount * FEE_RATE);
  $('merchantNet').textContent = fmtUsd(amount * (1 - FEE_RATE));
}
function makeMoneroUri(address, xmr, merchant, invoiceId) {
  const params = new URLSearchParams({
    tx_amount:Number(xmr).toFixed(12).replace(/0+$/,'').replace(/\.$/,''),
    recipient_name:merchant,
    tx_description:`XMR Tap ${invoiceId}`
  });
  return `monero:${address}?${params.toString()}`;
}

async function createInvoice() {
  if (!setupReady()) {
    setView('settings');
    return toast('Complete merchant setup before accepting payments.');
  }

  const amountUsd = saleAmount();
  if (amountUsd <= 0) return toast('Enter a sale amount first.');

  const quote = state.quote;
  const xmrAmount = amountUsd / quote;
  const id = shortId('XRT');
  const note = $('saleNote').value.trim();
  const reference = $('saleReference').value.trim();
  const base = state.settings.backendUrl?.trim();
  let address = null;
  let addressIndex = null;
  let source = 'demo';

  const health = base ? await apiHealth() : null;
  if (base && health) {
    try {
      const r = await fetch(`${base.replace(/\/$/,'')}/api/invoices`, {
        method:'POST',
        headers:authHeaders({'Content-Type':'application/json'}),
        referrerPolicy:'no-referrer',
        body:JSON.stringify({ invoiceId:id, amountUsd, xmrAmount, quoteUsdPerXmr:quote, note, reference })
      });
      if (!r.ok) {
        const err = await r.json().catch(()=>({}));
        throw new Error(err.error || 'backend invoice failed');
      }
      const data = await r.json();
      address = data.address;
      addressIndex = data.addressIndex ?? null;
      source = data.mode || 'rpc';
    } catch (e) {
      toast(e.message || 'Private backend unavailable.');
      return;
    }
  } else {
    address = makeDemoAddress();
    source = 'demo';
    toast('Demo invoice only — configure the private backend before using real funds.');
  }

  const customerReceiptPublicKey = await generateDemoCustomerCredential(id);
  const uri = makeMoneroUri(address, xmrAmount, state.settings.merchantName, id);
  const invoice = {
    id, createdAt:nowIso(), note, reference, amountUsd,
    quoteUsdPerXmr:quote, xmrAmount,
    feeUsd:amountUsd * FEE_RATE,
    merchantNetUsd:amountUsd * (1 - FEE_RATE),
    address, addressIndex, uri,
    invoiceNonce:randomHex(16),
    status:'waiting',
    source,
    customerReceiptPublicKey,
    refundDestinationStored:false,
    refundAddressPrivate:null,
    txid:null,
    paidAt:null,
    receipt:null,
    refunds:[]
  };

  state.invoices.unshift(invoice);
  state.activeInvoiceId = id;
  persistInvoices();
  renderActiveInvoice();
  renderActivity();
  startPaymentPolling();
}

function persistInvoices() { saveJson(STORAGE.invoices, state.invoices); }
function activeInvoice() { return state.invoices.find(x => x.id === state.activeInvoiceId); }
function settlementLabel(inv) {
  if (inv.source === 'rpc') return 'Private invoice subaddress';
  if (inv.source === 'demo') return 'Demo invoice address';
  return 'Invoice destination';
}

function renderActiveInvoice() {
  const inv = activeInvoice();
  $('emptyPaymentState').classList.toggle('hidden', !!inv);
  $('activePaymentState').classList.toggle('hidden', !inv);
  if (!inv) return;

  $('invoiceIdButton').textContent = inv.id;
  $('invoiceUsdAmount').textContent = fmtUsd(inv.amountUsd);
  $('invoiceXmrAmount').textContent = fmtXmr(inv.xmrAmount);
  $('invoicePurchaseCaption').textContent = [inv.note,inv.reference].filter(Boolean).join(' · ');
  $('paymentStatusPill').textContent = inv.status === 'paid' ? 'Paid' : inv.status === 'refunded' ? 'Refunded' : 'Waiting for payment';
  $('paymentStatusPill').className = `status-pill ${inv.status}`;
  $('demoControls').classList.toggle('hidden', inv.status !== 'waiting');
  $('paidActions').classList.toggle('hidden', !['paid','refunded'].includes(inv.status));
  $('settlementModeLabel').textContent = settlementLabel(inv);
  $('settlementAddressLabel').textContent = inv.address || '—';

  const q = $('qrCode');
  q.innerHTML = '';
  if (window.QRCode) new QRCode(q, { text:inv.uri, width:176, height:176, correctLevel:QRCode.CorrectLevel.M });
}

function nfcPayload(inv) {
  return {
    protocol:'xmrtap',
    version:2,
    type:'invoice',
    merchant:{
      name:state.settings.merchantName,
      profileImageIncluded:Boolean(state.settings.profileImage)
    },
    invoiceId:inv.id,
    itemDescription:inv.note || '',
    merchantReference:inv.reference || '',
    fiat:{currency:'USD',amountMinor:Math.round(inv.amountUsd * 100)},
    monero:{
      amountAtomic:atomicUnits(inv.xmrAmount),
      amountXmr:Number(inv.xmrAmount.toFixed(12)),
      paymentUri:inv.uri,
      quoteUsdPerXmr:inv.quoteUsdPerXmr
    },
    privacy:{
      senderAddressRequested:false,
      requestOneTimeRefundAddress:true,
      refundAddressScope:'this invoice only'
    },
    invoiceNonce:inv.invoiceNonce,
    receipt:{customerPublicKey:inv.customerReceiptPublicKey},
    expiresAt:new Date(new Date(inv.createdAt).getTime() + 10*60*1000).toISOString()
  };
}

function showNfc() {
  const inv = activeInvoice();
  if (!inv) return;
  $('nfcPayloadPreview').textContent = JSON.stringify(nfcPayload(inv), null, 2);
  $('nfcModal').classList.remove('hidden');
}

async function registerPrivateRefundDestination(inv, address) {
  inv.refundAddressPrivate = address;
  inv.refundDestinationStored = true;

  const base = state.settings.backendUrl?.trim();
  if (base && inv.source === 'rpc') {
    try {
      const r = await fetch(`${base.replace(/\/$/,'')}/api/invoices/${encodeURIComponent(inv.id)}/refund-destination`, {
        method:'POST',
        headers:authHeaders({'Content-Type':'application/json'}),
        referrerPolicy:'no-referrer',
        body:JSON.stringify({address})
      });
      if (r.ok) {
        inv.refundAddressPrivate = null;
        inv.refundDestinationStored = true;
      }
    } catch {}
  }
  persistInvoices();
}

async function markInvoicePaid(inv, txid, paidAt=nowIso()) {
  if (!inv || inv.status !== 'waiting') return;
  inv.status = 'paid';
  inv.paidAt = paidAt;
  inv.txid = txid || randomHex(32);

  const receiptCore = {
    protocol:'xmrtap-receipt',
    version:2,
    receiptId:shortId('RCP'),
    invoiceId:inv.id,
    merchantName:state.settings.merchantName,
    itemDescription:inv.note || '',
    merchantReference:inv.reference || '',
    amountUsd:inv.amountUsd,
    paidXmr:Number(inv.xmrAmount.toFixed(12)),
    quoteUsdPerXmr:inv.quoteUsdPerXmr,
    txid:inv.txid,
    paidAt:inv.paidAt,
    invoiceDestination:inv.address,
    refundDestinationStored:Boolean(inv.refundDestinationStored),
    customerReceiptPublicKey:inv.customerReceiptPublicKey,
    refundDenomination:'USD',
    invoiceNonce:inv.invoiceNonce
  };
  inv.receipt = await signReceipt(receiptCore);
  persistInvoices();
  renderActiveInvoice();
  renderActivity();
}

async function simulatePayment() {
  const inv = activeInvoice();
  if (!inv || inv.status !== 'waiting') return;
  const privateRefundAddress = makeDemoAddress();
  await registerPrivateRefundDestination(inv, privateRefundAddress);
  await markInvoicePaid(inv, randomHex(32));
  $('nfcModal').classList.add('hidden');
  toast('Payment detected. A private one-time refund destination was saved.');
}

function searchableText(inv) {
  return [
    inv.id,inv.txid,inv.receipt?.receiptId,inv.note,inv.reference,
    inv.amountUsd,inv.xmrAmount,inv.status,fmtDate(inv.createdAt)
  ].filter(Boolean).join(' ').toLowerCase();
}
function filteredInvoices(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return state.invoices;
  return state.invoices.filter(inv => searchableText(inv).includes(q));
}

function totalRefunds() {
  return state.invoices.reduce((sum,inv) => sum + (inv.refunds || []).reduce((s,r) => s + Number(r.amountUsd || 0),0),0);
}

function renderActivity() {
  const settled = state.invoices.filter(x => ['paid','refunded'].includes(x.status));
  const gross = settled.reduce((s,x) => s + Number(x.amountUsd || 0),0);
  const fees = settled.reduce((s,x) => s + Number(x.feeUsd || 0),0);
  const refunds = totalRefunds();
  $('grossMetric').textContent = fmtUsd(gross);
  $('feesMetric').textContent = fmtUsd(fees);
  $('netMetric').textContent = fmtUsd(gross - fees - refunds);
  $('refundsMetric').textContent = fmtUsd(refunds);

  const query = $('activitySearch')?.value || '';
  const list = filteredInvoices(query);
  $('activityCount').textContent = `${list.length} transaction${list.length===1?'':'s'}`;
  $('clearActivitySearch').classList.toggle('hidden', !query.trim());

  const host = $('activityList');
  if (!list.length) {
    host.innerHTML = `<div class="empty-list">${query ? 'No transactions match that search.' : 'No invoices yet. Create your first sale.'}</div>`;
    return;
  }

  host.innerHTML = list.map(inv => `
    <button class="activity-row" data-open-transaction="${esc(inv.id)}">
      <div>
        <div class="id">${esc(inv.id)}</div>
        <small>${esc(inv.note || inv.reference || fmtDate(inv.createdAt))}</small>
      </div>
      <div class="net-cell"><small>Merchant net</small><strong>${fmtUsd(inv.merchantNetUsd)}</strong></div>
      <div class="amount">${fmtUsd(inv.amountUsd)}<small>${Number(inv.xmrAmount || 0).toFixed(5)} XMR</small></div>
      <span class="row-status ${esc(inv.status)}">${esc(inv.status)}</span>
    </button>
  `).join('');

  host.querySelectorAll('[data-open-transaction]').forEach(btn => btn.addEventListener('click', () => openTransaction(btn.dataset.openTransaction)));
}

function receiptLogoStyle() {
  return state.settings.profileImage ? `style="background-image:url('${state.settings.profileImage.replace(/'/g,'%27')}');color:transparent"` : '';
}
function receiptHtml(inv) {
  const totalRefunded = (inv.refunds || []).reduce((s,r) => s + Number(r.amountUsd || 0),0);
  return `
    <div class="receipt-card">
      <div class="receipt-brand">
        <div class="receipt-brand-left">
          <div class="receipt-logo" ${receiptLogoStyle()}>${esc(merchantInitial())}</div>
          <div><strong>${esc(state.settings.merchantName)}</strong><small>XMR Tap receipt</small></div>
        </div>
        <span class="receipt-paid">${inv.status === 'refunded' ? 'Refunded' : 'Paid'}</span>
      </div>

      <div class="receipt-total">
        <span>Purchase total</span>
        <strong>${fmtUsd(inv.amountUsd)}</strong>
        <small>${Number(inv.xmrAmount || 0).toFixed(8)} XMR</small>
      </div>

      <div class="receipt-items">
        <div class="receipt-item-label">Purchase</div>
        <div class="receipt-item-value">${esc(inv.note || 'Merchant purchase')}</div>
        ${inv.reference ? `<div style="color:#777;font-size:10px;margin-top:4px">${esc(inv.reference)}</div>` : ''}
      </div>

      <div class="receipt-grid">
        <div class="receipt-field"><span>Date paid</span><strong>${esc(fmtDate(inv.paidAt || inv.createdAt))}</strong></div>
        <div class="receipt-field"><span>USD / XMR quote</span><strong>${esc(fmtUsd(inv.quoteUsdPerXmr))}</strong></div>
        <div class="receipt-field"><span>Invoice</span><code>${esc(inv.id)}</code></div>
        <div class="receipt-field"><span>Receipt ID</span><code>${esc(inv.receipt?.receiptId || 'Pending')}</code></div>
        <div class="receipt-field" style="grid-column:1/-1"><span>Transaction ID</span><code>${esc(inv.txid || 'Pending')}</code></div>
      </div>

      ${totalRefunded>0 ? `<div style="margin-top:12px;padding:10px 12px;border-radius:10px;background:#eef3ff;color:#344a7c;font-size:11px"><strong>${fmtUsd(totalRefunded)}</strong> refunded from this purchase.</div>` : ''}
      <div class="receipt-footer">No customer name, reusable wallet address, home address, card number, or billing profile is stored on this receipt.</div>
    </div>
  `;
}

function transactionDetailHtml(inv) {
  const refundedTotal = (inv.refunds || []).reduce((s,r) => s + Number(r.amountUsd || 0),0);
  const remaining = Math.max(0,Number(inv.amountUsd || 0)-refundedTotal);
  const refunds = (inv.refunds || []).length
    ? `<div class="refund-history">${inv.refunds.map(r => `
      <div class="refund-entry"><div class="refund-entry-top"><strong>${fmtUsd(r.amountUsd)}</strong><span>${Number(r.xmrAmount || 0).toFixed(6)} XMR</span></div><small>${esc(fmtDate(r.createdAt))} · ${esc(shorten(r.txid,12,8))}</small></div>
    `).join('')}</div>`
    : '<div class="refund-history"><div class="empty-small">No refunds on this transaction.</div></div>';

  return `
    <div class="transaction-body">
      ${receiptHtml(inv)}
      <div class="record-section">
        <div class="record-section-title">Merchant transaction record</div>
        <div class="record-row"><span>Status</span><strong>${esc(inv.status)}</strong></div>
        <div class="record-row"><span>Created</span><strong>${esc(fmtDate(inv.createdAt))}</strong></div>
        <div class="record-row"><span>Paid</span><strong>${esc(fmtDate(inv.paidAt))}</strong></div>
        <div class="record-row"><span>Customer paid</span><strong>${fmtUsd(inv.amountUsd)} · ${Number(inv.xmrAmount || 0).toFixed(8)} XMR</strong></div>
        <div class="record-row"><span>XMR Tap fee (1%)</span><strong>${fmtUsd(inv.feeUsd)}</strong></div>
        <div class="record-row"><span>Merchant net before refunds</span><strong>${fmtUsd(inv.merchantNetUsd)}</strong></div>
        <div class="record-row"><span>Invoice destination</span><strong>${esc(settlementLabel(inv))}</strong></div>
        <div class="record-row"><span>TXID</span><code>${esc(inv.txid || '—')}</code></div>
        <div class="record-row"><span>Private refund destination</span><strong>${inv.refundDestinationStored ? 'Stored ✓' : 'Not provided'}</strong></div>
        <div class="record-row"><span>Refundable USD remaining</span><strong>${fmtUsd(remaining)}</strong></div>
      </div>
      <div class="record-section"><div class="record-section-title">Refund history</div>${refunds}</div>
      <div class="transaction-actions">
        <button class="secondary-button" data-download-receipt="${esc(inv.id)}">Download receipt data</button>
        <button class="primary-button" data-start-refund="${esc(inv.id)}" ${remaining<=0 || inv.status==='waiting' ? 'disabled' : ''}>Start refund</button>
      </div>
    </div>
  `;
}

function openTransaction(id) {
  const inv = state.invoices.find(x => x.id === id);
  if (!inv) return toast('Transaction not found.');
  state.detailInvoiceId = id;
  $('transactionTitle').textContent = inv.id;
  $('transactionDetail').innerHTML = transactionDetailHtml(inv);
  $('transactionModal').classList.remove('hidden');

  $('transactionDetail').querySelectorAll('[data-download-receipt]').forEach(btn =>
    btn.addEventListener('click', () => downloadReceiptById(btn.dataset.downloadReceipt)));
  $('transactionDetail').querySelectorAll('[data-start-refund]').forEach(btn =>
    btn.addEventListener('click', () => startRefundFromTransaction(btn.dataset.startRefund)));
}
function closeTransaction() { $('transactionModal').classList.add('hidden'); }
function startRefundFromTransaction(id) {
  const inv = state.invoices.find(x => x.id === id);
  if (!inv) return;
  state.refundInvoiceId = id;
  $('refundSearch').value = inv.id;
  closeTransaction();
  setView('refunds');
  renderRefundSelection();
}

function findRefund() {
  const q = $('refundSearch').value.trim().toLowerCase();
  if (!q) return toast('Enter something from the transaction.');
  const matches = state.invoices.filter(x => ['paid','refunded'].includes(x.status) && searchableText(x).includes(q));
  if (!matches.length) {
    state.refundInvoiceId = null;
    renderRefundSelection();
    return toast('No paid purchase matched that search.');
  }
  if (matches.length > 1) {
    $('refundSearchResult').className = 'refund-result';
    $('refundSearchResult').innerHTML = `
      <strong>${matches.length} purchases found</strong>
      ${matches.slice(0,6).map(inv => `<button class="secondary-button compact" style="width:100%;margin-top:7px" data-refund-match="${esc(inv.id)}">${esc(inv.id)} · ${fmtUsd(inv.amountUsd)} · ${esc(inv.note || inv.reference || '')}</button>`).join('')}
    `;
    $('refundSearchResult').querySelectorAll('[data-refund-match]').forEach(btn => btn.addEventListener('click', () => {
      state.refundInvoiceId = btn.dataset.refundMatch;
      renderRefundSelection();
    }));
    return;
  }
  state.refundInvoiceId = matches[0].id;
  renderRefundSelection();
}

function renderRefundSelection() {
  const inv = state.invoices.find(x => x.id === state.refundInvoiceId);
  $('refundFormEmpty').classList.toggle('hidden', !!inv);
  $('refundForm').classList.toggle('hidden', !inv);
  if (!inv) {
    $('refundSearchResult').className = 'refund-result empty-small';
    $('refundSearchResult').textContent = 'No purchase selected.';
    return;
  }

  const refundedSoFar = (inv.refunds || []).reduce((s,r) => s + Number(r.amountUsd || 0),0);
  const remaining = Math.max(0,inv.amountUsd-refundedSoFar);
  $('refundSearchResult').className = 'refund-result';
  $('refundSearchResult').innerHTML = `
    <strong>${esc(inv.id)} · ${fmtUsd(inv.amountUsd)}</strong>
    <div class="line"><span>Purchase</span><b>${esc(inv.note || '—')}</b></div>
    <div class="line"><span>Order ref</span><b>${esc(inv.reference || '—')}</b></div>
    <div class="line"><span>Status</span><b>${esc(inv.status)}</b></div>
    <div class="line"><span>TXID</span><b>${esc(shorten(inv.txid,12,8))}</b></div>
    <div class="line"><span>Receipt</span><b>${esc(inv.receipt?.receiptId || '—')}</b></div>
    <div class="line"><span>Refundable</span><b>${fmtUsd(remaining)}</b></div>
    <button class="secondary-button compact" id="openRefundTransactionBtn" style="width:100%;margin-top:12px">Open full transaction</button>
  `;
  $('openRefundTransactionBtn').addEventListener('click', () => openTransaction(inv.id));

  $('refundUsd').value = remaining.toFixed(2);
  $('refundAddress').value = '';
  const stored = Boolean(inv.refundDestinationStored);
  $('refundDestinationCard').classList.toggle('missing', !stored);
  $('refundDestinationStatus').textContent = stored ? 'One-time destination stored ✓' : 'No private destination saved';
  $('refundDestinationHint').textContent = stored
    ? 'The address is hidden from the merchant UI and linked only to this purchase.'
    : 'This payment came from a legacy wallet flow, so a fresh refund address is required.';
  $('legacyRefundAddressWrap').classList.toggle('hidden', stored);
  $('processRefundBtn').textContent = stored ? 'Refund to saved private destination' : 'Process legacy refund';
  updateRefundSummary();
}

function updateRefundSummary() {
  const amount = Number($('refundUsd')?.value || 0);
  if ($('refundQuote')) $('refundQuote').textContent = `${fmtUsd(state.quote)} / XMR`;
  if ($('refundXmr')) $('refundXmr').textContent = fmtXmr(amount > 0 ? amount / state.quote : 0);
}

async function processRefund() {
  const inv = state.invoices.find(x => x.id === state.refundInvoiceId);
  if (!inv) return;

  const amountUsd = Number($('refundUsd').value);
  const refundedSoFar = (inv.refunds || []).reduce((s,r) => s + Number(r.amountUsd || 0),0);
  const remaining = Math.max(0,inv.amountUsd-refundedSoFar);
  if (!(amountUsd > 0) || amountUsd > remaining + 0.0001) return toast(`Refund must be between $0.01 and ${fmtUsd(remaining)}.`);

  const xmrAmount = amountUsd / state.quote;
  const base = state.settings.backendUrl?.trim();
  const health = base ? await apiHealth() : null;
  let refundTxid = randomHex(32);
  let mode = 'demo';

  if (base && health) {
    const legacyAddress = inv.refundDestinationStored ? '' : $('refundAddress').value.trim();
    if (!inv.refundDestinationStored && !validMoneroAddress(legacyAddress)) return toast('Enter a valid fresh Monero refund address.');

    try {
      const r = await fetch(`${base.replace(/\/$/,'')}/api/refunds`, {
        method:'POST',
        headers:authHeaders({'Content-Type':'application/json'}),
        referrerPolicy:'no-referrer',
        body:JSON.stringify({
          invoiceId:inv.id,
          amountUsd,
          xmrAmount,
          quoteUsdPerXmr:state.quote,
          legacyAddress:legacyAddress || undefined
        })
      });
      if (!r.ok) {
        const err = await r.json().catch(()=>({}));
        throw new Error(err.error || 'refund failed');
      }
      const data = await r.json();
      refundTxid = data.txid || refundTxid;
      mode = data.mode || 'rpc';
    } catch (e) {
      return toast(e.message || 'Backend refund failed. Nothing was sent.');
    }
  } else {
    const destination = inv.refundAddressPrivate || $('refundAddress').value.trim();
    if (!inv.refundDestinationStored && !validMoneroAddress(destination)) return toast('Enter a valid fresh Monero refund address.');
  }

  inv.refunds = inv.refunds || [];
  inv.refunds.push({
    id:shortId('RFD'),createdAt:nowIso(),amountUsd,
    quoteUsdPerXmr:state.quote,xmrAmount,txid:refundTxid,mode
  });
  const totalRefunded = inv.refunds.reduce((s,r) => s + Number(r.amountUsd || 0),0);
  if (totalRefunded >= inv.amountUsd - 0.005) inv.status = 'refunded';
  persistInvoices();
  renderRefundSelection();
  renderActivity();
  renderActiveInvoice();
  toast(mode === 'demo' ? 'Demo refund recorded. No XMR was sent.' : 'Refund sent to the saved private destination.');
}

function reviewWallet() {
  const address = $('merchantWalletInput').value.trim();
  if (!validMoneroAddress(address)) return toast('That does not look like a valid Monero address.');
  state.pendingPayoutAddress = address;
  $('walletConfirmAddress').textContent = address;
  $('walletFinalConfirmAddress').textContent = address;
  $('walletConfirmCheckbox').checked = false;
  $('futurePaymentsConfirmCheckbox').checked = false;
  $('confirmWalletBtn').disabled = true;
  $('activateWalletBtn').disabled = true;
  $('walletFinalConfirmModal').classList.add('hidden');
  $('walletConfirmModal').classList.remove('hidden');
}

function continueWalletConfirmation() {
  const address = state.pendingPayoutAddress;
  if (!validMoneroAddress(address) || !$('walletConfirmCheckbox').checked) return;
  $('walletFinalConfirmAddress').textContent = address;
  $('futurePaymentsConfirmCheckbox').checked = false;
  $('activateWalletBtn').disabled = true;
  $('walletConfirmModal').classList.add('hidden');
  $('walletFinalConfirmModal').classList.remove('hidden');
}

function backToWalletReview() {
  $('walletFinalConfirmModal').classList.add('hidden');
  $('walletConfirmModal').classList.remove('hidden');
}

async function confirmWallet() {
  const address = state.pendingPayoutAddress;
  if (!validMoneroAddress(address) || !$('walletConfirmCheckbox').checked || !$('futurePaymentsConfirmCheckbox').checked) return;

  const base = $('backendUrlInput').value.trim();
  state.settings.backendUrl = base;
  state.accessToken = $('merchantAccessKeyInput').value.trim();
  if (state.accessToken) sessionStorage.setItem('xmrtap.accessToken', state.accessToken);
  if (base && !state.accessToken) return toast('Enter the merchant access key for the private backend.');
  let backendManaged = false;
  let masked = maskAddress(address);

  if (base) {
    try {
      const r = await fetch(`${base.replace(/\/$/,'')}/api/merchant/setup`, {
        method:'POST',
        headers:authHeaders({'Content-Type':'application/json'}),
        referrerPolicy:'no-referrer',
        body:JSON.stringify({
          merchantName:$('merchantNameInput').value.trim() || state.settings.merchantName,
          profileImage:state.settings.profileImage || '',
          payoutAddress:address
        })
      });
      if (!r.ok) {
        const err = await r.json().catch(()=>({}));
        throw new Error(err.error || 'secure payout setup failed');
      }
      const data = await r.json();
      masked = data.payoutMasked || masked;
      backendManaged = true;
    } catch (e) {
      return toast(`${e.message}. Wallet was not saved.`);
    }
  }

  state.settings.payoutConfirmed = true;
  state.settings.payoutMasked = masked;
  state.settings.backendManagedPayout = backendManaged;
  state.pendingPayoutAddress = '';
  $('merchantWalletInput').value = '';
  saveSettingsLocal();
  $('walletConfirmModal').classList.add('hidden');
  $('walletFinalConfirmModal').classList.add('hidden');
  renderSetupState();
  await updateModeLabel();
  toast(backendManaged ? 'Payout wallet encrypted and saved on the private backend.' : 'Demo payout confirmed. Add a private backend before accepting real funds.');
}

function changeWallet() {
  state.settings.payoutConfirmed = false;
  state.settings.payoutMasked = '';
  state.settings.backendManagedPayout = false;
  saveSettingsLocal();
  renderSetupState();
  $('merchantWalletInput').value = '';
  $('merchantWalletInput').focus();
  toast('Checkout locked until the new payout wallet is confirmed.');
}

function saveSettingsLocal() {
  saveJson(STORAGE.settings, state.settings);
}

async function saveProfile() {
  state.settings.merchantName = $('merchantNameInput').value.trim() || 'Merchant';
  state.settings.backendUrl = $('backendUrlInput').value.trim();
  state.accessToken = $('merchantAccessKeyInput').value.trim();
  if (state.accessToken) sessionStorage.setItem('xmrtap.accessToken', state.accessToken);
  else sessionStorage.removeItem('xmrtap.accessToken');
  saveSettingsLocal();
  renderMerchantIdentity();
  renderSetupState();
  await syncBackendProfile();
  await updateModeLabel();
  toast('Merchant profile saved.');
}

async function syncBackendProfile() {
  const base = state.settings.backendUrl?.trim();
  if (!base || !state.settings.backendManagedPayout) return;
  try {
    await fetch(`${base.replace(/\/$/,'')}/api/merchant/profile`, {
      method:'POST',
      headers:authHeaders({'Content-Type':'application/json'}),
      referrerPolicy:'no-referrer',
      body:JSON.stringify({
        merchantName:state.settings.merchantName,
        profileImage:state.settings.profileImage || ''
      })
    });
  } catch {}
}

async function handleProfileImage(file) {
  try {
    state.settings.profileImage = await resizeProfileImage(file);
    saveSettingsLocal();
    renderMerchantIdentity();
    await syncBackendProfile();
    toast('Profile picture updated.');
  } catch (e) {
    toast(e.message || 'Could not use that image.');
  }
}
async function removeProfileImage() {
  state.settings.profileImage = '';
  saveSettingsLocal();
  renderMerchantIdentity();
  await syncBackendProfile();
  toast('Profile picture removed.');
}

function startPaymentPolling() {
  clearInterval(state.paymentPollTimer);
  const inv = activeInvoice();
  const base = state.settings.backendUrl?.trim();
  if (!inv || inv.status !== 'waiting' || inv.source !== 'rpc' || !base) return;

  state.paymentPollTimer = setInterval(async () => {
    const current = activeInvoice();
    if (!current || current.status !== 'waiting') return clearInterval(state.paymentPollTimer);
    try {
      const r = await fetch(`${base.replace(/\/$/,'')}/api/invoices/${encodeURIComponent(current.id)}`, { headers:authHeaders(), referrerPolicy:'no-referrer' });
      if (!r.ok) return;
      const data = await r.json();
      if (data.refundDestinationStored) current.refundDestinationStored = true;
      if (data.status === 'paid' && data.txid) {
        clearInterval(state.paymentPollTimer);
        await markInvoicePaid(current,data.txid,data.paidAt || nowIso());
        toast('Incoming XMR matched to this invoice.');
      }
    } catch {}
  },4000);
}

function downloadReceiptById(id) {
  const inv = state.invoices.find(x => x.id === id);
  if (!inv?.receipt) return toast('Receipt is not available yet.');
  const payload = {
    receipt:inv.receipt,
    purchase:{
      itemDescription:inv.note || '',merchantReference:inv.reference || '',
      grossUsd:inv.amountUsd,paidXmr:inv.xmrAmount,quoteUsdPerXmr:inv.quoteUsdPerXmr
    },
    refundDestinationStored:Boolean(inv.refundDestinationStored),
    refunds:inv.refunds || []
  };
  downloadBlob(`${inv.receipt.receiptId}.json`,'application/json',JSON.stringify(payload,null,2));
}
function downloadBlob(name,type,content) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content],{type}));
  a.download = name;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),500);
}
function exportCsv() {
  const headers = ['invoice_id','created_at','paid_at','status','item','merchant_reference','gross_usd','fee_usd','merchant_net_usd','xmr_amount','quote_usd_per_xmr','txid','receipt_id','refund_destination_stored'];
  const rows = state.invoices.map(i => [
    i.id,i.createdAt,i.paidAt||'',i.status,i.note||'',i.reference||'',i.amountUsd,i.feeUsd,i.merchantNetUsd,i.xmrAmount,i.quoteUsdPerXmr,i.txid||'',i.receipt?.receiptId||'',Boolean(i.refundDestinationStored)
  ]);
  const csv = [headers,...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\n');
  downloadBlob('xmr-tap-activity.csv','text/csv',csv);
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'),3000);
}

function bindEvents() {
  document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
  $('completeSetupBtn').addEventListener('click', () => setView('settings'));

  $('saleAmount').addEventListener('input', updateSaleSummary);
  document.querySelectorAll('[data-amount]').forEach(btn => btn.addEventListener('click', () => {
    $('saleAmount').value = btn.dataset.amount;
    updateSaleSummary();
  }));
  $('createInvoiceBtn').addEventListener('click', createInvoice);
  $('copyUriBtn').addEventListener('click', async () => {
    const inv = activeInvoice();
    if (!inv) return;
    await navigator.clipboard.writeText(inv.uri);
    toast('Payment request copied.');
  });
  $('showNfcBtn').addEventListener('click', showNfc);
  $('closeNfcBtn').addEventListener('click', () => $('nfcModal').classList.add('hidden'));
  $('nfcModal').addEventListener('click', e => { if (e.target === $('nfcModal')) $('nfcModal').classList.add('hidden'); });
  $('copyNfcBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('nfcPayloadPreview').textContent);
    toast('NFC payload copied.');
  });
  $('simulateWalletTapBtn').addEventListener('click', simulatePayment);
  $('simulatePayBtn').addEventListener('click', simulatePayment);
  $('invoiceIdButton').addEventListener('click', () => { const inv=activeInvoice(); if(inv) openTransaction(inv.id); });
  $('viewPaidTransactionBtn').addEventListener('click', () => { const inv=activeInvoice(); if(inv) openTransaction(inv.id); });

  $('exportBtn').addEventListener('click', exportCsv);
  $('activitySearch').addEventListener('input', renderActivity);
  $('clearActivitySearch').addEventListener('click', () => { $('activitySearch').value=''; renderActivity(); $('activitySearch').focus(); });

  $('findRefundBtn').addEventListener('click', findRefund);
  $('refundSearch').addEventListener('keydown', e => { if(e.key==='Enter') findRefund(); });
  $('refundUsd').addEventListener('input', updateRefundSummary);
  $('processRefundBtn').addEventListener('click', processRefund);

  $('saveProfileBtn').addEventListener('click', saveProfile);
  $('profileImageInput').addEventListener('change', e => { if(e.target.files?.[0]) handleProfileImage(e.target.files[0]); e.target.value=''; });
  $('removeProfileImageBtn').addEventListener('click', removeProfileImage);
  $('reviewWalletBtn').addEventListener('click', reviewWallet);
  $('walletConfirmCheckbox').addEventListener('change', e => { $('confirmWalletBtn').disabled = !e.target.checked; });
  $('confirmWalletBtn').addEventListener('click', continueWalletConfirmation);
  $('futurePaymentsConfirmCheckbox').addEventListener('change', e => { $('activateWalletBtn').disabled = !e.target.checked; });
  $('activateWalletBtn').addEventListener('click', confirmWallet);
  $('closeWalletConfirmBtn').addEventListener('click', () => $('walletConfirmModal').classList.add('hidden'));
  $('cancelWalletConfirmBtn').addEventListener('click', () => $('walletConfirmModal').classList.add('hidden'));
  $('walletConfirmModal').addEventListener('click', e => { if(e.target === $('walletConfirmModal')) $('walletConfirmModal').classList.add('hidden'); });
  $('closeWalletFinalConfirmBtn').addEventListener('click', () => $('walletFinalConfirmModal').classList.add('hidden'));
  $('backToWalletReviewBtn').addEventListener('click', backToWalletReview);
  $('walletFinalConfirmModal').addEventListener('click', e => { if(e.target === $('walletFinalConfirmModal')) $('walletFinalConfirmModal').classList.add('hidden'); });
  $('changeWalletBtn').addEventListener('click', changeWallet);

  $('closeTransactionBtn').addEventListener('click', closeTransaction);
  $('transactionModal').addEventListener('click', e => { if(e.target === $('transactionModal')) closeTransaction(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeTransaction();
      $('nfcModal').classList.add('hidden');
      $('walletConfirmModal').classList.add('hidden');
      $('walletFinalConfirmModal').classList.add('hidden');
    }
  });
}

async function init() {
  state.invoices = state.invoices.map(inv => ({
    reference:'',
    paidAt:inv.paidAt || null,
    refunds:[],
    refundDestinationStored:Boolean(inv.refundDestinationStored),
    refundAddressPrivate:inv.refundAddressPrivate || null,
    ...inv
  }));
  persistInvoices();

  $('merchantNameInput').value = state.settings.merchantName;
  $('backendUrlInput').value = state.settings.backendUrl || '';
  $('merchantAccessKeyInput').value = state.accessToken || '';

  bindEvents();
  renderMerchantIdentity();
  renderSetupState();
  renderActivity();
  renderRefundSelection();
  await getMerchantKeyPair();
  await refreshBackendState();
  await refreshQuote();
  await updateModeLabel();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
}

init();
