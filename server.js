/**
 * XMR Tap privacy-first beta backend.
 * Node 20+, no dependencies.
 *
 * Privacy goals:
 * - no application-level IP/User-Agent logging
 * - merchant payout address encrypted at rest
 * - one-time customer refund destinations encrypted at rest
 * - browser never contacts the quote provider directly
 * - production Wallet RPC creates a unique subaddress per invoice
 *
 * Required for secure persistent setup:
 *   XMR_TAP_DATA_KEY=<long random secret>
 *
 * Real settlement:
 *   DEMO_MODE=false
 *   WALLET_RPC_URL=http://127.0.0.1:18082/json_rpc
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const DEMO_MODE = process.env.DEMO_MODE !== 'false';
const WALLET_RPC_URL = process.env.WALLET_RPC_URL || 'http://127.0.0.1:18082/json_rpc';
const WALLET_RPC_USER = process.env.WALLET_RPC_USER || '';
const WALLET_RPC_PASSWORD = process.env.WALLET_RPC_PASSWORD || '';
const ACCOUNT_INDEX = Number(process.env.XMR_ACCOUNT_INDEX || 0);
const DATA_KEY_SECRET = process.env.XMR_TAP_DATA_KEY || '';
const DATA_FILE = process.env.XMR_TAP_DATA_FILE || path.join(process.cwd(), 'data', 'xmrtap.enc');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const ADMIN_TOKEN = process.env.XMR_TAP_ADMIN_TOKEN || '';

let quoteCache = { usdPerXmr:null, at:0, source:'CoinGecko' };
let memoryStore = { merchant:null, invoices:{} };

function secureConfigReady() {
  return DATA_KEY_SECRET.length >= 24;
}
function encryptionKey() {
  if (!secureConfigReady()) throw new Error('XMR_TAP_DATA_KEY must be at least 24 characters');
  return crypto.createHash('sha256').update(DATA_KEY_SECRET).digest();
}
function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v:1,
    iv:iv.toString('base64'),
    tag:tag.toString('base64'),
    data:encrypted.toString('base64')
  });
}
function decryptJson(payload) {
  const box = JSON.parse(payload);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(box.iv,'base64'));
  decipher.setAuthTag(Buffer.from(box.tag,'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(box.data,'base64')),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}
function loadStore() {
  if (!secureConfigReady() || !fs.existsSync(DATA_FILE)) return memoryStore;
  try {
    const parsed = decryptJson(fs.readFileSync(DATA_FILE,'utf8'));
    if (parsed && typeof parsed === 'object') memoryStore = { merchant:null, invoices:{}, ...parsed };
  } catch {
    // Deliberately do not log decrypted data, request metadata, or secrets.
  }
  return memoryStore;
}
function saveStore() {
  if (!secureConfigReady()) return;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive:true });
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, encryptJson(memoryStore), { mode:0o600 });
  fs.renameSync(temp, DATA_FILE);
}
loadStore();

function corsHeaders() {
  return {
    'access-control-allow-origin':ALLOWED_ORIGIN,
    'access-control-allow-headers':'content-type, x-xmr-tap-token',
    'access-control-allow-methods':'GET,POST,OPTIONS',
    'referrer-policy':'no-referrer',
    'x-content-type-options':'nosniff',
    'cache-control':'no-store',
    'permissions-policy':'geolocation=(), camera=(), microphone=(), interest-cohort=()'
  };
}
function json(res,status,body) {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8', ...corsHeaders()});
  res.end(JSON.stringify(body));
}
function randomHex(bytes=32){ return crypto.randomBytes(bytes).toString('hex'); }
function requireAuth(req) {
  if (!ADMIN_TOKEN) {
    if (DEMO_MODE) return;
    throw new Error('XMR_TAP_ADMIN_TOKEN is required in production');
  }
  const supplied = String(req.headers['x-xmr-tap-token'] || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) throw new Error('unauthorized merchant request');
}
function demoAddress() {
  const chars='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s='8';
  for(let i=0;i<94;i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}
function validMoneroAddress(address) {
  const a = String(address || '').trim();
  return [95,106].includes(a.length)
    && ['4','8'].includes(a[0])
    && /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(a);
}
function maskAddress(address) {
  const a = String(address || '').trim();
  return a ? `${a.slice(0,8)}••••••••${a.slice(-8)}` : '';
}
function cleanProfileImage(value) {
  const s = String(value || '');
  if (!s) return '';
  if (!/^data:image\/(png|jpeg|webp);base64,/i.test(s)) throw new Error('profile image must be png/jpeg/webp data URL');
  if (s.length > 600000) throw new Error('profile image is too large');
  return s;
}
async function readBody(req) {
  return await new Promise((resolve,reject)=>{
    let data='';
    req.on('data',chunk=>{
      data += chunk;
      if (data.length > 900000) {
        reject(new Error('request too large'));
        req.destroy();
      }
    });
    req.on('end',()=>{
      try { resolve(data ? JSON.parse(data) : {}); }
      catch(e){ reject(new Error('invalid JSON')); }
    });
    req.on('error',reject);
  });
}

async function rpc(method,params={}) {
  const headers = {'content-type':'application/json'};
  if (WALLET_RPC_USER || WALLET_RPC_PASSWORD) {
    throw new Error('Digest-auth wallet RPC is not supported by this dependency-free beta. Put Wallet RPC behind a private authenticated local proxy before production.');
  }
  const r = await fetch(WALLET_RPC_URL,{
    method:'POST',
    headers,
    body:JSON.stringify({jsonrpc:'2.0',id:'xmrtap',method,params})
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error?.message || `RPC ${r.status}`);
  return data.result;
}

function merchantSummary() {
  const merchant = memoryStore.merchant;
  if (!merchant) return {
    setupComplete:false,
    merchantName:'',
    profileImage:'',
    payoutMasked:'',
    secureStorage:secureConfigReady()
  };
  return {
    setupComplete:Boolean(merchant.payoutAddress),
    merchantName:merchant.merchantName || '',
    profileImage:merchant.profileImage || '',
    payoutMasked:maskAddress(merchant.payoutAddress),
    secureStorage:secureConfigReady()
  };
}

function requireSecureStorage() {
  if (!secureConfigReady()) throw new Error('Secure merchant storage is not configured on this server');
}
function requireMerchantSetup() {
  if (!memoryStore.merchant?.payoutAddress) throw new Error('Merchant payout setup is incomplete');
}

async function setupMerchant(body) {
  requireSecureStorage();
  const payoutAddress = String(body.payoutAddress || '').trim();
  const merchantName = String(body.merchantName || '').trim();
  if (!merchantName) throw new Error('merchantName is required');
  if (!validMoneroAddress(payoutAddress)) throw new Error('valid Monero payout address required');

  memoryStore.merchant = {
    merchantName:merchantName.slice(0,100),
    profileImage:cleanProfileImage(body.profileImage),
    payoutAddress,
    updatedAt:new Date().toISOString()
  };
  saveStore();
  return merchantSummary();
}

async function updateMerchantProfile(body) {
  requireSecureStorage();
  requireMerchantSetup();
  const merchantName = String(body.merchantName || memoryStore.merchant.merchantName || '').trim();
  if (!merchantName) throw new Error('merchantName is required');
  memoryStore.merchant.merchantName = merchantName.slice(0,100);
  memoryStore.merchant.profileImage = cleanProfileImage(body.profileImage);
  memoryStore.merchant.updatedAt = new Date().toISOString();
  saveStore();
  return merchantSummary();
}

async function getQuote() {
  const now = Date.now();
  if (quoteCache.usdPerXmr && now - quoteCache.at < 30000) return quoteCache;

  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd', {
      headers:{'accept':'application/json'}
    });
    if (!r.ok) throw new Error('quote provider unavailable');
    const data = await r.json();
    const price = Number(data?.monero?.usd);
    if (!price) throw new Error('invalid quote');
    quoteCache = { usdPerXmr:price, at:now, source:'CoinGecko via XMR Tap server' };
    return quoteCache;
  } catch {
    return {
      usdPerXmr:quoteCache.usdPerXmr || 623.23,
      at:quoteCache.at || now,
      source:quoteCache.usdPerXmr ? 'cached private proxy' : 'server fallback'
    };
  }
}

async function createInvoice(body) {
  if (!DEMO_MODE) requireMerchantSetup();

  const id = String(body.invoiceId || `XRT-${Date.now()}`).slice(0,100);
  const amountUsd = Number(body.amountUsd);
  const xmrAmount = Number(body.xmrAmount);
  if (!(amountUsd > 0) || !(xmrAmount > 0)) throw new Error('positive invoice amounts are required');

  let address;
  let addressIndex = null;
  let mode = 'demo';

  if (DEMO_MODE) {
    address = demoAddress();
  } else {
    const out = await rpc('create_address',{
      account_index:ACCOUNT_INDEX,
      label:`XMR Tap ${id}`
    });
    address = out.address;
    addressIndex = out.address_index;
    mode = 'rpc';
  }

  const invoice = {
    invoiceId:id,
    amountUsd,
    xmrAmount,
    quoteUsdPerXmr:Number(body.quoteUsdPerXmr || 0),
    note:String(body.note || '').slice(0,120),
    reference:String(body.reference || '').slice(0,60),
    address,
    addressIndex,
    mode,
    createdAt:new Date().toISOString(),
    paidAt:null,
    status:'waiting',
    txid:null,
    confirmations:0,
    refundAddressPrivate:null,
    refunds:[]
  };

  memoryStore.invoices[id] = invoice;
  saveStore();
  return { address, addressIndex, mode, invoiceId:id };
}

async function registerRefundDestination(id,body) {
  const inv = memoryStore.invoices[id];
  if (!inv) throw new Error('invoice not found');
  const address = String(body.address || '').trim();
  if (!validMoneroAddress(address)) throw new Error('valid one-time Monero refund address required');
  inv.refundAddressPrivate = address;
  inv.refundDestinationStored = true;
  inv.refundDestinationUpdatedAt = new Date().toISOString();
  saveStore();
  return { ok:true, refundDestinationStored:true };
}

async function checkInvoice(id) {
  const inv = memoryStore.invoices[id];
  if (!inv) return null;

  if (!DEMO_MODE && inv.addressIndex != null && inv.status === 'waiting') {
    const out = await rpc('get_transfers',{
      in:true,
      pool:true,
      account_index:ACCOUNT_INDEX,
      subaddr_indices:[inv.addressIndex]
    });
    const transfers = [...(out.in || []), ...(out.pool || [])];
    const expected = Math.round(Number(inv.xmrAmount || 0) * 1e12);
    const match = transfers.find(t => Number(t.amount) >= expected);

    if (match) {
      inv.status = 'paid';
      inv.txid = match.txid;
      inv.confirmations = match.confirmations || 0;
      inv.paidAt = new Date().toISOString();
      saveStore();
    }
  }

  return {
    invoiceId:inv.invoiceId,
    status:inv.status,
    txid:inv.txid,
    confirmations:inv.confirmations || 0,
    paidAt:inv.paidAt,
    refundDestinationStored:Boolean(inv.refundAddressPrivate)
  };
}

async function refund(body) {
  const invoiceId = String(body.invoiceId || '');
  const inv = memoryStore.invoices[invoiceId];
  if (!inv) throw new Error('invoice not found');

  const amountUsd = Number(body.amountUsd);
  const xmrAmount = Number(body.xmrAmount);
  const amountAtomic = Math.round(xmrAmount * 1e12);
  if (!(amountUsd > 0) || !amountAtomic) throw new Error('positive refund amount required');

  const alreadyRefunded = (inv.refunds || []).reduce((sum,r) => sum + Number(r.amountUsd || 0),0);
  if (amountUsd > Number(inv.amountUsd) - alreadyRefunded + 0.0001) throw new Error('refund exceeds remaining purchase value');

  const legacyAddress = String(body.legacyAddress || '').trim();
  const destination = inv.refundAddressPrivate || legacyAddress;
  if (!validMoneroAddress(destination)) throw new Error('no private refund destination is stored; a fresh legacy refund address is required');

  let txid;
  let mode;
  let feeAtomic = 0;

  if (DEMO_MODE) {
    txid = randomHex(32);
    mode = 'demo';
  } else {
    const out = await rpc('transfer',{
      account_index:ACCOUNT_INDEX,
      destinations:[{address:destination,amount:amountAtomic}]
    });
    txid = out.tx_hash;
    feeAtomic = out.fee || 0;
    mode = 'rpc';
  }

  inv.refunds = inv.refunds || [];
  inv.refunds.push({
    id:`RFD-${Date.now().toString(36).toUpperCase()}-${randomHex(3).toUpperCase()}`,
    createdAt:new Date().toISOString(),
    amountUsd,
    xmrAmount,
    quoteUsdPerXmr:Number(body.quoteUsdPerXmr || 0),
    txid,
    mode
  });

  const totalRefunded = inv.refunds.reduce((sum,r) => sum + Number(r.amountUsd || 0),0);
  if (totalRefunded >= Number(inv.amountUsd) - 0.005) inv.status = 'refunded';
  saveStore();

  return { txid, feeAtomic, mode, refundDestination:'private-saved-destination' };
}

const server = http.createServer(async (req,res)=>{
  if (req.method === 'OPTIONS') return json(res,204,{});
  const url = new URL(req.url,`http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res,200,{
        ok:true,
        mode:DEMO_MODE ? 'demo' : 'rpc',
        secureConfigReady:secureConfigReady(),
        authConfigured:Boolean(ADMIN_TOKEN),
        merchantSetupComplete:Boolean(memoryStore.merchant?.payoutAddress),
        privacy:{requestLogging:false,analytics:false}
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/quote') {
      const quote = await getQuote();
      return json(res,200,quote);
    }

    if (req.method === 'GET' && url.pathname === '/api/merchant') {
      return json(res,200,merchantSummary());
    }

    if (req.method === 'POST' && url.pathname === '/api/merchant/setup') {
      requireAuth(req);
      return json(res,200,await setupMerchant(await readBody(req)));
    }

    if (req.method === 'POST' && url.pathname === '/api/merchant/profile') {
      requireAuth(req);
      return json(res,200,await updateMerchantProfile(await readBody(req)));
    }

    if (req.method === 'POST' && url.pathname === '/api/invoices') {
      requireAuth(req);
      return json(res,201,await createInvoice(await readBody(req)));
    }

    const refundDestinationMatch = url.pathname.match(/^\/api\/invoices\/([^/]+)\/refund-destination$/);
    if (req.method === 'POST' && refundDestinationMatch) {
      requireAuth(req);
      return json(res,200,await registerRefundDestination(decodeURIComponent(refundDestinationMatch[1]),await readBody(req)));
    }

    const invoiceMatch = url.pathname.match(/^\/api\/invoices\/([^/]+)$/);
    if (req.method === 'GET' && invoiceMatch) {
      requireAuth(req);
      const out = await checkInvoice(decodeURIComponent(invoiceMatch[1]));
      return out ? json(res,200,out) : json(res,404,{error:'invoice not found'});
    }

    if (req.method === 'POST' && url.pathname === '/api/refunds') {
      requireAuth(req);
      return json(res,200,await refund(await readBody(req)));
    }

    return json(res,404,{error:'not found'});
  } catch (e) {
    return json(res,500,{error:e.message});
  }
});

server.listen(PORT,()=>{
  // Startup output intentionally contains no request IPs, wallet addresses, or transaction metadata.
  console.log(`XMR Tap backend ready on port ${PORT} (${DEMO_MODE ? 'demo' : 'rpc'} mode)`);
});
