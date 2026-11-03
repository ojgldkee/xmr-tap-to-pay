const FEE_RATE = 0.01;
const DEFAULT_QUOTE = 623.23;
const STORAGE = {
  invoices: 'xmrtap.invoices.v1',
  settings: 'xmrtap.settings.v1',
  merchantKey: 'xmrtap.merchantKey.v1',
  demoWalletKeys: 'xmrtap.demoWalletKeys.v1'
};

const state = {
  quote: DEFAULT_QUOTE,
  quoteSource: 'fallback',
  invoices: loadJson(STORAGE.invoices, []),
  settings: loadJson(STORAGE.settings, { merchantName: 'Demo Merchant', backendUrl: '' }),
  activeInvoiceId: null,
  refundInvoiceId: null,
  merchantKeyPair: null
};

const $ = (id) => document.getElementById(id);
const fmtUsd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n || 0));
const fmtXmr = (n) => `${Number(n || 0).toFixed(6)} XMR`;
const nowIso = () => new Date().toISOString();

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes); crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}
function base64Url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function shortId(prefix = 'XRT') { return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomHex(3).toUpperCase()}`; }
function atomicUnits(xmr) { return Math.round(Number(xmr) * 1e12); }
function fromAtomic(v) { return Number(v) / 1e12; }

function makeDemoAddress() {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes = new Uint8Array(94); crypto.getRandomValues(bytes);
  return '8' + [...bytes].map(b => alphabet[b % alphabet.length]).join('');
}

async function getMerchantKeyPair() {
  if (state.merchantKeyPair) return state.merchantKeyPair;
  const stored = loadJson(STORAGE.merchantKey, null);
  if (stored?.privateKey && stored?.publicKey) {
    try {
      const privateKey = await crypto.subtle.importKey('jwk', stored.privateKey, {name:'ECDSA', namedCurve:'P-256'}, true, ['sign']);
      const publicKey = await crypto.subtle.importKey('jwk', stored.publicKey, {name:'ECDSA', namedCurve:'P-256'}, true, ['verify']);
      state.merchantKeyPair = { privateKey, publicKey };
      return state.merchantKeyPair;
    } catch {}
  }
  const pair = await crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign','verify']);
  const exported = {
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey)
  };
  saveJson(STORAGE.merchantKey, exported);
  state.merchantKeyPair = pair;
  return pair;
}

async function signReceipt(receiptCore) {
  const pair = await getMerchantKeyPair();
  const data = new TextEncoder().encode(JSON.stringify(receiptCore));
  const signature = await crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, pair.privateKey, data);
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { ...receiptCore, signature: base64Url(signature), merchantReceiptPublicKey: publicKey };
}

async function generateDemoCustomerCredential(invoiceId) {
  const pair = await crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign','verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const all = loadJson(STORAGE.demoWalletKeys, {});
  all[invoiceId] = { publicKey, privateKey };
  saveJson(STORAGE.demoWalletKeys, all);
  return publicKey;
}

async function refreshQuote() {
  const status = $('quoteStatus');
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd', { cache: 'no-store' });
    if (!response.ok) throw new Error('quote request failed');
    const data = await response.json();
    if (!data?.monero?.usd) throw new Error('quote missing');
    state.quote = Number(data.monero.usd);
    state.quoteSource = 'CoinGecko';
    status.textContent = 'Live market quote';
  } catch {
    state.quote = DEFAULT_QUOTE;
    state.quoteSource = 'fallback';
    status.textContent = 'Demo fallback quote';
  }
  $('xmrQuote').textContent = fmtUsd(state.quote);
  updateSaleSummary();
  updateRefundSummary();
}

function setView(name) {
  document.querySelectorAll('.nav-item').forEach(btn => btn.classList.toggle('active', btn.dataset.view === name));
  document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
  $(`${name}View`).classList.add('active');
  const titles = { sale:'New sale', activity:'Activity', refunds:'Refunds', settings:'Settings' };
  $('viewTitle').textContent = titles[name];
  if (name === 'activity') renderActivity();
}

function saleAmount() {
  const raw = $('saleAmount').value.trim().replace(/[^0-9.]/g, '');
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
    tx_amount: Number(xmr).toFixed(12).replace(/0+$/,'').replace(/\.$/,''),
    recipient_name: merchant,
    tx_description: `XMR Tap ${invoiceId}`
  });
  return `monero:${address}?${params.toString()}`;
}

async function apiHealth() {
  const base = state.settings.backendUrl?.trim();
  if (!base) return false;
  try {
    const r = await fetch(`${base.replace(/\/$/,'')}/api/health`);
    if (!r.ok) return false;
    const data = await r.json();
    return data?.ok === true;
  } catch { return false; }
}

async function createInvoice() {
  const amountUsd = saleAmount();
  if (amountUsd <= 0) return toast('Enter a sale amount first.');
  const quote = state.quote;
  const xmrAmount = amountUsd / quote;
  const id = shortId('XRT');
  const note = $('saleNote').value.trim();
  const base = state.settings.backendUrl?.trim();
  let walletAddress, addressIndex = null, source = 'demo';

  if (base && await apiHealth()) {
    try {
      const r = await fetch(`${base.replace(/\/$/,'')}/api/invoices`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ invoiceId:id, amountUsd, xmrAmount, quoteUsdPerXmr:quote, note })
      });
      if (!r.ok) throw new Error('backend invoice failed');
      const data = await r.json();
      walletAddress = data.address;
      addressIndex = data.addressIndex ?? null;
      source = data.mode || 'rpc';
    } catch (e) {
      toast('Backend unavailable — created a demo invoice instead.');
    }
  }

  if (!walletAddress) walletAddress = makeDemoAddress();
  const customerReceiptPublicKey = await generateDemoCustomerCredential(id);
  const uri = makeMoneroUri(walletAddress, xmrAmount, state.settings.merchantName, id);
  const invoice = {
    id,
    createdAt: nowIso(),
    note,
    amountUsd,
    quoteUsdPerXmr: quote,
    xmrAmount,
    feeUsd: amountUsd * FEE_RATE,
    merchantNetUsd: amountUsd * (1 - FEE_RATE),
    address: walletAddress,
    addressIndex,
    uri,
    invoiceNonce: randomHex(16),
    status: 'waiting',
    source,
    customerReceiptPublicKey,
    txid: null,
    receipt: null,
    refunds: []
  };
  state.invoices.unshift(invoice);
  state.activeInvoiceId = id;
  persistInvoices();
  renderActiveInvoice();
}

function persistInvoices() { saveJson(STORAGE.invoices, state.invoices); }
function activeInvoice() { return state.invoices.find(x => x.id === state.activeInvoiceId); }

function renderActiveInvoice() {
  const invoice = activeInvoice();
  $('emptyPaymentState').classList.toggle('hidden', !!invoice);
  $('activePaymentState').classList.toggle('hidden', !invoice);
  if (!invoice) return;

  $('invoiceIdLabel').textContent = invoice.id;
  $('invoiceUsdAmount').textContent = fmtUsd(invoice.amountUsd);
  $('invoiceXmrAmount').textContent = fmtXmr(invoice.xmrAmount);
  $('paymentStatusPill').textContent = invoice.status === 'paid' ? 'Paid' : invoice.status === 'refunded' ? 'Refunded' : 'Waiting for payment';
  $('paymentStatusPill').className = `status-pill ${invoice.status === 'waiting' ? 'waiting' : 'paid'}`;
  $('demoControls').classList.toggle('hidden', invoice.status !== 'waiting');
  $('txBox').classList.toggle('hidden', !invoice.txid);
  $('receiptBox').classList.toggle('hidden', !invoice.receipt);
  if (invoice.txid) $('txidLabel').textContent = invoice.txid;
  if (invoice.receipt) $('receiptIdLabel').textContent = invoice.receipt.receiptId;

  const q = $('qrCode'); q.innerHTML = '';
  if (window.QRCode) {
    new QRCode(q, { text: invoice.uri, width: 176, height: 176, correctLevel: QRCode.CorrectLevel.M });
  } else {
    q.innerHTML = '<div style="color:#111;font-size:11px;text-align:center">QR library unavailable<br>Use Copy payment request</div>';
  }
}

function nfcPayload(invoice) {
  return {
    protocol: 'xmrtap',
    version: 1,
    type: 'invoice',
    merchantName: state.settings.merchantName,
    invoiceId: invoice.id,
    fiat: { currency:'USD', amountMinor: Math.round(invoice.amountUsd * 100) },
    monero: {
      amountAtomic: atomicUnits(invoice.xmrAmount),
      amountXmr: Number(invoice.xmrAmount.toFixed(12)),
      paymentUri: invoice.uri,
      quoteUsdPerXmr: invoice.quoteUsdPerXmr
    },
    invoiceNonce: invoice.invoiceNonce,
    receipt: { customerPublicKey: invoice.customerReceiptPublicKey },
    expiresAt: new Date(new Date(invoice.createdAt).getTime() + 10 * 60 * 1000).toISOString()
  };
}

function showNfc() {
  const invoice = activeInvoice(); if (!invoice) return;
  $('nfcPayloadPreview').textContent = JSON.stringify(nfcPayload(invoice), null, 2);
  $('nfcModal').classList.remove('hidden');
}

async function simulatePayment() {
  const invoice = activeInvoice();
  if (!invoice || invoice.status !== 'waiting') return;
  invoice.status = 'paid';
  invoice.paidAt = nowIso();
  invoice.txid = randomHex(32);
  const receiptCore = {
    protocol: 'xmrtap-receipt', version: 1,
    receiptId: shortId('RCP'), invoiceId: invoice.id,
    merchantName: state.settings.merchantName,
    amountUsd: invoice.amountUsd,
    paidXmr: Number(invoice.xmrAmount.toFixed(12)),
    quoteUsdPerXmr: invoice.quoteUsdPerXmr,
    txid: invoice.txid,
    paidAt: invoice.paidAt,
    customerReceiptPublicKey: invoice.customerReceiptPublicKey,
    refundDenomination: 'USD',
    invoiceNonce: invoice.invoiceNonce
  };
  invoice.receipt = await signReceipt(receiptCore);
  persistInvoices();
  renderActiveInvoice();
  renderActivity();
  $('nfcModal').classList.add('hidden');
  toast('Payment detected and receipt signed.');
}

function renderActivity() {
  const paid = state.invoices.filter(x => ['paid','refunded'].includes(x.status));
  const gross = paid.reduce((s,x) => s + x.amountUsd, 0);
  const fees = paid.reduce((s,x) => s + x.feeUsd, 0);
  $('grossMetric').textContent = fmtUsd(gross);
  $('feesMetric').textContent = fmtUsd(fees);
  $('netMetric').textContent = fmtUsd(gross - fees);
  const host = $('activityList');
  if (!state.invoices.length) {
    host.innerHTML = '<div class="empty-list">No invoices yet. Create your first sale.</div>';
    return;
  }
  host.innerHTML = state.invoices.map(inv => `
    <div class="activity-row">
      <div><div class="id">${esc(inv.id)}</div><small>${esc(inv.note || new Date(inv.createdAt).toLocaleString())}</small></div>
      <div class="net-cell"><small>Merchant net</small><strong>${fmtUsd(inv.merchantNetUsd)}</strong></div>
      <div class="amount">${fmtUsd(inv.amountUsd)}<small>${Number(inv.xmrAmount).toFixed(5)} XMR</small></div>
      <span class="row-status ${inv.status}">${inv.status}</span>
    </div>`).join('');
}

function findRefund() {
  const q = $('refundSearch').value.trim().toLowerCase();
  if (!q) return toast('Enter an invoice, receipt, or transaction ID.');
  const inv = state.invoices.find(x => x.id.toLowerCase() === q || x.txid?.toLowerCase() === q || x.receipt?.receiptId?.toLowerCase() === q);
  if (!inv || !['paid','refunded'].includes(inv.status)) {
    state.refundInvoiceId = null; renderRefundSelection(); return toast('No paid purchase matched that ID.');
  }
  state.refundInvoiceId = inv.id;
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
  $('refundSearchResult').className = 'refund-result';
  $('refundSearchResult').innerHTML = `<strong>${esc(inv.id)} · ${fmtUsd(inv.amountUsd)}</strong>
    <div class="line"><span>Status</span><b>${esc(inv.status)}</b></div>
    <div class="line"><span>TXID</span><b>${esc((inv.txid || '').slice(0,12))}…</b></div>
    <div class="line"><span>Receipt</span><b>${esc(inv.receipt?.receiptId || '—')}</b></div>`;
  $('refundUsd').value = inv.amountUsd.toFixed(2);
  $('refundAddress').value = '';
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
  const address = $('refundAddress').value.trim();
  const refundedSoFar = (inv.refunds || []).reduce((s,r) => s + r.amountUsd, 0);
  const remaining = Math.max(0, inv.amountUsd - refundedSoFar);
  if (!(amountUsd > 0) || amountUsd > remaining + 0.0001) return toast(`Refund must be between $0.01 and ${fmtUsd(remaining)}.`);
  if (address.length < 20) return toast('Enter the fresh refund address supplied by the customer wallet.');

  const xmrAmount = amountUsd / state.quote;
  let refundTxid = randomHex(32), mode = 'demo';
  const base = state.settings.backendUrl?.trim();
  if (base && await apiHealth()) {
    try {
      const r = await fetch(`${base.replace(/\/$/,'')}/api/refunds`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ invoiceId:inv.id, amountUsd, xmrAmount, quoteUsdPerXmr:state.quote, address })
      });
      if (!r.ok) throw new Error('refund failed');
      const data = await r.json();
      refundTxid = data.txid || refundTxid; mode = data.mode || 'rpc';
    } catch { return toast('Backend refund failed. Nothing was sent.'); }
  }

  inv.refunds = inv.refunds || [];
  inv.refunds.push({ id:shortId('RFD'), createdAt:nowIso(), amountUsd, quoteUsdPerXmr:state.quote, xmrAmount, address, txid:refundTxid, mode });
  const totalRefunded = inv.refunds.reduce((s,r) => s + r.amountUsd, 0);
  if (totalRefunded >= inv.amountUsd - 0.005) inv.status = 'refunded';
  persistInvoices();
  renderRefundSelection(); renderActivity(); renderActiveInvoice();
  toast(mode === 'demo' ? 'Demo refund recorded. No XMR was sent.' : 'Refund sent through Monero Wallet RPC.');
}

function exportCsv() {
  const headers = ['invoice_id','created_at','status','gross_usd','fee_usd','merchant_net_usd','xmr_amount','quote_usd_per_xmr','txid','receipt_id'];
  const rows = state.invoices.map(i => [i.id,i.createdAt,i.status,i.amountUsd,i.feeUsd,i.merchantNetUsd,i.xmrAmount,i.quoteUsdPerXmr,i.txid||'',i.receipt?.receiptId||'']);
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  downloadBlob('xmr-tap-activity.csv', 'text/csv', csv);
}

function downloadReceipt() {
  const inv = activeInvoice(); if (!inv?.receipt) return;
  downloadBlob(`${inv.receipt.receiptId}.json`, 'application/json', JSON.stringify(inv.receipt, null, 2));
}
function downloadBlob(name, type, content) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], {type})); a.download = name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 500);
}

function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

function saveSettings() {
  state.settings.merchantName = $('merchantNameInput').value.trim() || 'Demo Merchant';
  state.settings.backendUrl = $('backendUrlInput').value.trim();
  saveJson(STORAGE.settings, state.settings);
  $('merchantNameHeader').textContent = state.settings.merchantName;
  toast('Settings saved.');
  updateModeLabel();
}

async function updateModeLabel() {
  const online = await apiHealth();
  $('modeLabel').textContent = online ? 'RPC backend connected' : 'Demo mode';
}

function bindEvents() {
  document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
  $('saleAmount').addEventListener('input', updateSaleSummary);
  document.querySelectorAll('[data-amount]').forEach(btn => btn.addEventListener('click', () => { $('saleAmount').value = btn.dataset.amount; updateSaleSummary(); }));
  $('createInvoiceBtn').addEventListener('click', createInvoice);
  $('copyUriBtn').addEventListener('click', async () => { const i=activeInvoice(); if(i){ await navigator.clipboard.writeText(i.uri); toast('Payment request copied.'); } });
  $('showNfcBtn').addEventListener('click', showNfc);
  $('closeNfcBtn').addEventListener('click', () => $('nfcModal').classList.add('hidden'));
  $('nfcModal').addEventListener('click', e => { if (e.target === $('nfcModal')) $('nfcModal').classList.add('hidden'); });
  $('copyNfcBtn').addEventListener('click', async () => { await navigator.clipboard.writeText($('nfcPayloadPreview').textContent); toast('NFC payload copied.'); });
  $('simulateWalletTapBtn').addEventListener('click', simulatePayment);
  $('simulatePayBtn').addEventListener('click', simulatePayment);
  $('downloadReceiptBtn').addEventListener('click', downloadReceipt);
  $('exportBtn').addEventListener('click', exportCsv);
  $('findRefundBtn').addEventListener('click', findRefund);
  $('refundSearch').addEventListener('keydown', e => { if(e.key === 'Enter') findRefund(); });
  $('refundUsd').addEventListener('input', updateRefundSummary);
  $('processRefundBtn').addEventListener('click', processRefund);
  $('saveSettingsBtn').addEventListener('click', saveSettings);
}

async function init() {
  $('merchantNameInput').value = state.settings.merchantName;
  $('backendUrlInput').value = state.settings.backendUrl || '';
  $('merchantNameHeader').textContent = state.settings.merchantName;
  bindEvents();
  renderActivity();
  renderRefundSelection();
  await getMerchantKeyPair();
  await refreshQuote();
  await updateModeLabel();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(()=>{});
}

init();
