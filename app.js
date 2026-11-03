const FEE_RATE = 0.01;
const DEFAULT_QUOTE = 623.23;
const STORAGE = {
  invoices: 'xmrtap.invoices.v1',
  settings: 'xmrtap.settings.v1',
  merchantKey: 'xmrtap.merchantKey.v1',
  demoWalletKeys: 'xmrtap.demoWalletKeys.v1'
};

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

const savedSettings = loadJson(STORAGE.settings, {});
const state = {
  quote: DEFAULT_QUOTE,
  quoteSource: 'fallback',
  invoices: loadJson(STORAGE.invoices, []),
  settings: {
    merchantName: 'Demo Merchant',
    backendUrl: '',
    merchantWalletAddress: '',
    ...savedSettings
  },
  activeInvoiceId: null,
  refundInvoiceId: null,
  detailInvoiceId: null,
  merchantKeyPair: null,
  paymentPollTimer: null
};

const $ = id => document.getElementById(id);
const fmtUsd = n => new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(Number(n || 0));
const fmtXmr = n => `${Number(n || 0).toFixed(6)} XMR`;
const fmtDate = iso => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString([], { dateStyle:'medium', timeStyle:'short' }); } catch { return iso; }
};
const nowIso = () => new Date().toISOString();

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2,'0')).join('');
}
function base64Url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function shortId(prefix='XRT') {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomHex(3).toUpperCase()}`;
}
function atomicUnits(xmr) { return Math.round(Number(xmr) * 1e12); }
function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function shorten(value, head=12, tail=8) {
  const s = String(value || '');
  if (s.length <= head + tail + 3) return s || '—';
  return `${s.slice(0,head)}…${s.slice(-tail)}`;
}
function validMoneroAddress(address) {
  const a = String(address || '').trim();
  if (![95,106].includes(a.length)) return false;
  if (!['4','8'].includes(a[0])) return false;
  return /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(a);
}
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
      const privateKey = await crypto.subtle.importKey('jwk', stored.privateKey, {name:'ECDSA',namedCurve:'P-256'}, true, ['sign']);
      const publicKey = await crypto.subtle.importKey('jwk', stored.publicKey, {name:'ECDSA',namedCurve:'P-256'}, true, ['verify']);
      state.merchantKeyPair = { privateKey, publicKey };
      return state.merchantKeyPair;
    } catch {}
  }
  const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, true, ['sign','verify']);
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

async function refreshQuote() {
  const status = $('quoteStatus');
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd', { cache:'no-store' });
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
  if (name === 'settings') renderWalletStatus();
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
    tx_amount: Number(xmr).toFixed(12).replace(/0+$/,'').replace(/\.$/,''),
    recipient_name: merchant,
    tx_description: `XMR Tap ${invoiceId}`
  });
  return `monero:${address}?${params.toString()}`;
}

async function apiHealth() {
  const base = state.settings.backendUrl?.trim();
  if (!base) return null;
  try {
    const r = await fetch(`${base.replace(/\/$/,'')}/api/health`);
    if (!r.ok) return null;
    const data = await r.json();
    return data?.ok ? data : null;
  } catch { return null; }
}

function walletConnectionState() {
  const address = state.settings.merchantWalletAddress?.trim() || '';
  return { address, valid: validMoneroAddress(address) };
}
function renderWalletStatus() {
  const { address, valid } = walletConnectionState();
  const card = $('walletStatusCard');
  const hint = $('walletCheckoutHint');
  if (card) {
    card.classList.toggle('connected', valid);
    card.innerHTML = valid
      ? `<div class="connection-icon">M</div><div><strong>Merchant wallet connected</strong><small>${esc(shorten(address,12,10))} · Direct-settlement ready</small></div>`
      : `<div class="connection-icon">M</div><div><strong>No wallet connected</strong><small>Payments stay in demo mode until you add a valid XMR address or Wallet RPC.</small></div>`;
  }
  if (hint) {
    hint.classList.toggle('connected', valid);
    hint.innerHTML = valid
      ? `<span class="wallet-hint-dot"></span><div><strong>Direct settlement enabled</strong><small>Payment requests will send XMR to ${esc(shorten(address,10,8))}. Wallet RPC can upgrade this to unique invoice subaddresses.</small></div>`
      : `<span class="wallet-hint-dot"></span><div><strong>No merchant wallet connected</strong><small>Add your XMR receiving address in Settings, or connect Wallet RPC for unique invoice subaddresses.</small></div>`;
  }
}

async function createInvoice() {
  const amountUsd = saleAmount();
  if (amountUsd <= 0) return toast('Enter a sale amount first.');
  const quote = state.quote;
  const xmrAmount = amountUsd / quote;
  const id = shortId('XRT');
  const note = $('saleNote').value.trim();
  const reference = $('saleReference').value.trim();
  const base = state.settings.backendUrl?.trim();
  const merchantWallet = state.settings.merchantWalletAddress?.trim();
  let walletAddress = null;
  let addressIndex = null;
  let source = 'demo';

  const health = base ? await apiHealth() : null;
  if (base && health) {
    try {
      const r = await fetch(`${base.replace(/\/$/,'')}/api/invoices`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          invoiceId:id, amountUsd, xmrAmount, quoteUsdPerXmr:quote,
          note, reference, merchantAddress: validMoneroAddress(merchantWallet) ? merchantWallet : ''
        })
      });
      if (!r.ok) throw new Error('backend invoice failed');
      const data = await r.json();
      walletAddress = data.address;
      addressIndex = data.addressIndex ?? null;
      source = data.mode || 'rpc';
    } catch {
      toast('Backend unavailable — using direct wallet or demo mode.');
    }
  }

  if (!walletAddress && validMoneroAddress(merchantWallet)) {
    walletAddress = merchantWallet;
    source = 'connected-wallet';
  }
  if (!walletAddress) {
    walletAddress = makeDemoAddress();
    source = 'demo';
  }

  const customerReceiptPublicKey = await generateDemoCustomerCredential(id);
  const uri = makeMoneroUri(walletAddress, xmrAmount, state.settings.merchantName, id);
  const invoice = {
    id,
    createdAt: nowIso(),
    note,
    reference,
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
    paidAt: null,
    receipt: null,
    refunds: []
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

function settlementLabel(invoice) {
  if (invoice.source === 'rpc') return 'Unique wallet subaddress';
  if (invoice.source === 'connected-wallet' || invoice.source === 'direct-wallet') return 'Connected merchant wallet';
  return 'Demo address';
}

function renderActiveInvoice() {
  const invoice = activeInvoice();
  $('emptyPaymentState').classList.toggle('hidden', !!invoice);
  $('activePaymentState').classList.toggle('hidden', !invoice);
  if (!invoice) return;

  $('invoiceIdButton').textContent = invoice.id;
  $('invoiceUsdAmount').textContent = fmtUsd(invoice.amountUsd);
  $('invoiceXmrAmount').textContent = fmtXmr(invoice.xmrAmount);
  $('invoicePurchaseCaption').textContent = [invoice.note, invoice.reference].filter(Boolean).join(' · ');
  $('paymentStatusPill').textContent = invoice.status === 'paid' ? 'Paid' : invoice.status === 'refunded' ? 'Refunded' : 'Waiting for payment';
  $('paymentStatusPill').className = `status-pill ${invoice.status}`;
  $('demoControls').classList.toggle('hidden', invoice.status !== 'waiting');
  $('paidActions').classList.toggle('hidden', !['paid','refunded'].includes(invoice.status));
  $('settlementModeLabel').textContent = settlementLabel(invoice);
  $('settlementAddressLabel').textContent = invoice.address || '—';

  const q = $('qrCode');
  q.innerHTML = '';
  if (window.QRCode) {
    new QRCode(q, { text:invoice.uri, width:176, height:176, correctLevel:QRCode.CorrectLevel.M });
  } else {
    q.innerHTML = '<div style="color:#111;font-size:11px;text-align:center">QR unavailable<br>Use Copy payment request</div>';
  }
}

function nfcPayload(invoice) {
  return {
    protocol:'xmrtap',
    version:1,
    type:'invoice',
    merchantName:state.settings.merchantName,
    invoiceId:invoice.id,
    itemDescription:invoice.note || '',
    merchantReference:invoice.reference || '',
    fiat:{currency:'USD',amountMinor:Math.round(invoice.amountUsd * 100)},
    monero:{
      amountAtomic:atomicUnits(invoice.xmrAmount),
      amountXmr:Number(invoice.xmrAmount.toFixed(12)),
      paymentUri:invoice.uri,
      quoteUsdPerXmr:invoice.quoteUsdPerXmr
    },
    invoiceNonce:invoice.invoiceNonce,
    receipt:{customerPublicKey:invoice.customerReceiptPublicKey},
    expiresAt:new Date(new Date(invoice.createdAt).getTime() + 10 * 60 * 1000).toISOString()
  };
}

function showNfc() {
  const invoice = activeInvoice();
  if (!invoice) return;
  $('nfcPayloadPreview').textContent = JSON.stringify(nfcPayload(invoice), null, 2);
  $('nfcModal').classList.remove('hidden');
}

async function markInvoicePaid(invoice, txid, paidAt=nowIso()) {
  if (!invoice || invoice.status !== 'waiting') return;
  invoice.status = 'paid';
  invoice.paidAt = paidAt;
  invoice.txid = txid || randomHex(32);
  const receiptCore = {
    protocol:'xmrtap-receipt',
    version:1,
    receiptId:shortId('RCP'),
    invoiceId:invoice.id,
    merchantName:state.settings.merchantName,
    itemDescription:invoice.note || '',
    merchantReference:invoice.reference || '',
    amountUsd:invoice.amountUsd,
    paidXmr:Number(invoice.xmrAmount.toFixed(12)),
    quoteUsdPerXmr:invoice.quoteUsdPerXmr,
    txid:invoice.txid,
    paidAt:invoice.paidAt,
    settlementAddress:invoice.address,
    customerReceiptPublicKey:invoice.customerReceiptPublicKey,
    refundDenomination:'USD',
    invoiceNonce:invoice.invoiceNonce
  };
  invoice.receipt = await signReceipt(receiptCore);
  persistInvoices();
  renderActiveInvoice();
  renderActivity();
}

async function simulatePayment() {
  const invoice = activeInvoice();
  if (!invoice || invoice.status !== 'waiting') return;
  await markInvoicePaid(invoice, randomHex(32));
  $('nfcModal').classList.add('hidden');
  toast('Payment detected and receipt generated.');
}

function searchableText(inv) {
  return [
    inv.id, inv.txid, inv.receipt?.receiptId, inv.note, inv.reference,
    inv.amountUsd, inv.xmrAmount, inv.status, inv.address, fmtDate(inv.createdAt)
  ].filter(Boolean).join(' ').toLowerCase();
}
function filteredInvoices(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return state.invoices;
  return state.invoices.filter(inv => searchableText(inv).includes(q));
}

function renderActivity() {
  const settled = state.invoices.filter(x => ['paid','refunded'].includes(x.status));
  const gross = settled.reduce((s,x) => s + Number(x.amountUsd || 0), 0);
  const fees = settled.reduce((s,x) => s + Number(x.feeUsd || 0), 0);
  $('grossMetric').textContent = fmtUsd(gross);
  $('feesMetric').textContent = fmtUsd(fees);
  $('netMetric').textContent = fmtUsd(gross - fees);

  const query = $('activitySearch')?.value || '';
  const list = filteredInvoices(query);
  $('activityCount').textContent = `${list.length} transaction${list.length === 1 ? '' : 's'}`;
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

function receiptHtml(inv) {
  const receipt = inv.receipt;
  const totalRefunded = (inv.refunds || []).reduce((s,r) => s + Number(r.amountUsd || 0), 0);
  return `
    <div class="receipt-card">
      <div class="receipt-brand">
        <div class="receipt-brand-left">
          <div class="receipt-logo">M</div>
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
        <div class="receipt-field"><span>Receipt ID</span><code>${esc(receipt?.receiptId || 'Pending')}</code></div>
        <div class="receipt-field" style="grid-column:1/-1"><span>Transaction ID</span><code>${esc(inv.txid || 'Pending')}</code></div>
      </div>

      ${totalRefunded > 0 ? `<div style="margin-top:12px;padding:10px 12px;border-radius:10px;background:#eef3ff;color:#344a7c;font-size:11px"><strong>${fmtUsd(totalRefunded)}</strong> refunded from this purchase.</div>` : ''}

      <div class="receipt-footer">This receipt identifies the purchase without revealing the customer's reusable Monero wallet address.</div>
    </div>
  `;
}

function transactionDetailHtml(inv) {
  const refundedTotal = (inv.refunds || []).reduce((s,r) => s + Number(r.amountUsd || 0), 0);
  const remaining = Math.max(0, Number(inv.amountUsd || 0) - refundedTotal);
  const refunds = (inv.refunds || []).length
    ? `<div class="refund-history">${inv.refunds.map(r => `
        <div class="refund-entry">
          <div class="refund-entry-top"><strong>${fmtUsd(r.amountUsd)}</strong><span>${Number(r.xmrAmount || 0).toFixed(6)} XMR</span></div>
          <small>${esc(fmtDate(r.createdAt))} · ${esc(shorten(r.txid,12,8))}</small>
        </div>`).join('')}</div>`
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
        <div class="record-row"><span>Merchant net</span><strong>${fmtUsd(inv.merchantNetUsd)}</strong></div>
        <div class="record-row"><span>Settlement method</span><strong>${esc(settlementLabel(inv))}</strong></div>
        <div class="record-row"><span>Settlement address</span><code>${esc(inv.address || '—')}</code></div>
        <div class="record-row"><span>TXID</span><code>${esc(inv.txid || '—')}</code></div>
        <div class="record-row"><span>Refundable USD remaining</span><strong>${fmtUsd(remaining)}</strong></div>
      </div>

      <div class="record-section">
        <div class="record-section-title">Refund history</div>
        ${refunds}
      </div>

      <div class="transaction-actions">
        <button class="secondary-button" data-download-receipt="${esc(inv.id)}">Download receipt data</button>
        <button class="primary-button" data-start-refund="${esc(inv.id)}" ${remaining <= 0 || inv.status === 'waiting' ? 'disabled' : ''}>Start refund</button>
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
    btn.addEventListener('click', () => downloadReceiptById(btn.dataset.downloadReceipt))
  );
  $('transactionDetail').querySelectorAll('[data-start-refund]').forEach(btn =>
    btn.addEventListener('click', () => startRefundFromTransaction(btn.dataset.startRefund))
  );
}
function closeTransaction() {
  $('transactionModal').classList.add('hidden');
}
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
  const refundedSoFar = (inv.refunds || []).reduce((s,r) => s + Number(r.amountUsd || 0), 0);
  const remaining = Math.max(0, inv.amountUsd - refundedSoFar);
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
  const refundedSoFar = (inv.refunds || []).reduce((s,r) => s + Number(r.amountUsd || 0), 0);
  const remaining = Math.max(0, inv.amountUsd - refundedSoFar);
  if (!(amountUsd > 0) || amountUsd > remaining + 0.0001) return toast(`Refund must be between $0.01 and ${fmtUsd(remaining)}.`);
  if (!validMoneroAddress(address)) return toast('Enter a valid fresh Monero refund address.');

  const xmrAmount = amountUsd / state.quote;
  let refundTxid = randomHex(32);
  let mode = 'demo';
  const base = state.settings.backendUrl?.trim();
  const health = base ? await apiHealth() : null;
  if (base && health) {
    try {
      const r = await fetch(`${base.replace(/\/$/,'')}/api/refunds`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ invoiceId:inv.id, amountUsd, xmrAmount, quoteUsdPerXmr:state.quote, address })
      });
      if (!r.ok) throw new Error('refund failed');
      const data = await r.json();
      refundTxid = data.txid || refundTxid;
      mode = data.mode || 'rpc';
    } catch {
      return toast('Backend refund failed. Nothing was sent.');
    }
  }

  inv.refunds = inv.refunds || [];
  inv.refunds.push({
    id:shortId('RFD'),
    createdAt:nowIso(),
    amountUsd,
    quoteUsdPerXmr:state.quote,
    xmrAmount,
    address,
    txid:refundTxid,
    mode
  });
  const totalRefunded = inv.refunds.reduce((s,r) => s + Number(r.amountUsd || 0), 0);
  if (totalRefunded >= inv.amountUsd - 0.005) inv.status = 'refunded';
  persistInvoices();
  renderRefundSelection();
  renderActivity();
  renderActiveInvoice();
  toast(mode === 'demo' ? 'Demo refund recorded. No XMR was sent.' : 'Refund sent through Monero Wallet RPC.');
}

function downloadReceiptById(id) {
  const inv = state.invoices.find(x => x.id === id);
  if (!inv?.receipt) return toast('Receipt is not available yet.');
  const payload = {
    receipt:inv.receipt,
    purchase:{
      itemDescription:inv.note || '',
      merchantReference:inv.reference || '',
      grossUsd:inv.amountUsd,
      paidXmr:inv.xmrAmount,
      quoteUsdPerXmr:inv.quoteUsdPerXmr
    },
    refunds:inv.refunds || []
  };
  downloadBlob(`${inv.receipt.receiptId}.json`, 'application/json', JSON.stringify(payload, null, 2));
}
function downloadReceipt() {
  const inv = activeInvoice();
  if (inv) downloadReceiptById(inv.id);
}
function downloadBlob(name, type, content) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], {type}));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
}
function exportCsv() {
  const headers = ['invoice_id','created_at','paid_at','status','item','merchant_reference','gross_usd','fee_usd','merchant_net_usd','xmr_amount','quote_usd_per_xmr','txid','receipt_id','settlement_address'];
  const rows = state.invoices.map(i => [
    i.id,i.createdAt,i.paidAt||'',i.status,i.note||'',i.reference||'',i.amountUsd,i.feeUsd,i.merchantNetUsd,i.xmrAmount,i.quoteUsdPerXmr,i.txid||'',i.receipt?.receiptId||'',i.address||''
  ]);
  const csv = [headers,...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\n');
  downloadBlob('xmr-tap-activity.csv','text/csv',csv);
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 2800);
}

function saveSettings() {
  const merchantName = $('merchantNameInput').value.trim() || 'Demo Merchant';
  const backendUrl = $('backendUrlInput').value.trim();
  const merchantWalletAddress = $('merchantWalletInput').value.trim();

  if (merchantWalletAddress && !validMoneroAddress(merchantWalletAddress)) {
    return toast('That does not look like a valid Monero address.');
  }

  state.settings = { merchantName, backendUrl, merchantWalletAddress };
  saveJson(STORAGE.settings, state.settings);
  $('merchantNameHeader').textContent = merchantName;
  renderWalletStatus();
  updateModeLabel();
  toast(merchantWalletAddress ? 'Merchant wallet connected and settings saved.' : 'Settings saved.');
}

async function updateModeLabel() {
  const health = await apiHealth();
  const wallet = walletConnectionState();
  if (health?.mode === 'rpc') $('modeLabel').textContent = 'Wallet RPC connected';
  else if (wallet.valid) $('modeLabel').textContent = 'Direct wallet connected';
  else $('modeLabel').textContent = 'Demo mode';
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
      const r = await fetch(`${base.replace(/\/$/,'')}/api/invoices/${encodeURIComponent(current.id)}`);
      if (!r.ok) return;
      const data = await r.json();
      if (data.status === 'paid' && data.txid) {
        clearInterval(state.paymentPollTimer);
        await markInvoicePaid(current, data.txid, data.paidAt || nowIso());
        toast('Incoming XMR matched to this invoice.');
      }
    } catch {}
  }, 4000);
}

function bindEvents() {
  document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
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
  $('refundSearch').addEventListener('keydown', e => { if (e.key === 'Enter') findRefund(); });
  $('refundUsd').addEventListener('input', updateRefundSummary);
  $('processRefundBtn').addEventListener('click', processRefund);

  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('closeTransactionBtn').addEventListener('click', closeTransaction);
  $('transactionModal').addEventListener('click', e => { if (e.target === $('transactionModal')) closeTransaction(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeTransaction(); $('nfcModal').classList.add('hidden'); } });
}

async function init() {
  state.invoices = state.invoices.map(inv => ({
    reference:'',
    paidAt:inv.paidAt || null,
    refunds:[],
    ...inv
  }));

  $('merchantNameInput').value = state.settings.merchantName;
  $('backendUrlInput').value = state.settings.backendUrl || '';
  $('merchantWalletInput').value = state.settings.merchantWalletAddress || '';
  $('merchantNameHeader').textContent = state.settings.merchantName;

  bindEvents();
  renderWalletStatus();
  renderActivity();
  renderRefundSelection();
  await getMerchantKeyPair();
  await refreshQuote();
  await updateModeLabel();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
}

init();
