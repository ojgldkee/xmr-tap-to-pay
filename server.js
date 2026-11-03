/**
 * XMR Tap beta backend.
 * Node 20+, no dependencies.
 *
 * DEMO_MODE=true (default): generates synthetic subaddresses / txids and never sends funds.
 * DEMO_MODE=false: connects to monero-wallet-rpc using WALLET_RPC_URL.
 * Keep wallet RPC private; never expose it directly to browsers.
 */
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const DEMO_MODE = process.env.DEMO_MODE !== 'false';
const WALLET_RPC_URL = process.env.WALLET_RPC_URL || 'http://127.0.0.1:18082/json_rpc';
const WALLET_RPC_USER = process.env.WALLET_RPC_USER || '';
const WALLET_RPC_PASSWORD = process.env.WALLET_RPC_PASSWORD || '';
const ACCOUNT_INDEX = Number(process.env.XMR_ACCOUNT_INDEX || 0);
const invoices = new Map();

function json(res, status, body) {
  res.writeHead(status, {
    'content-type':'application/json; charset=utf-8',
    'access-control-allow-origin':'*',
    'access-control-allow-headers':'content-type',
    'access-control-allow-methods':'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(body));
}
function randomHex(bytes=32){ return crypto.randomBytes(bytes).toString('hex'); }
function demoAddress(){
  const chars='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s='8'; for(let i=0;i<94;i++) s+=chars[crypto.randomInt(chars.length)]; return s;
}
async function readBody(req) {
  return await new Promise((resolve,reject)=>{
    let data=''; req.on('data',c=>{ data+=c; if(data.length>1e6) req.destroy(); });
    req.on('end',()=>{ try{ resolve(data ? JSON.parse(data) : {}); }catch(e){ reject(e); } }); req.on('error',reject);
  });
}
async function rpc(method, params={}) {
  const headers = {'content-type':'application/json'};
  if (WALLET_RPC_USER || WALLET_RPC_PASSWORD) {
    throw new Error('Digest-auth wallet RPC is not supported by this dependency-free beta server. Put wallet-rpc behind a local reverse proxy or add a digest-auth client before production.');
  }
  const r = await fetch(WALLET_RPC_URL, { method:'POST', headers, body:JSON.stringify({jsonrpc:'2.0',id:'xmrtap',method,params}) });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error?.message || `RPC ${r.status}`);
  return data.result;
}

async function createInvoice(body) {
  const id = body.invoiceId || `XRT-${Date.now()}`;
  let address, addressIndex = null;
  if (DEMO_MODE) address = demoAddress();
  else {
    const out = await rpc('create_address', {account_index:ACCOUNT_INDEX,label:`XMR Tap ${id}`});
    address = out.address; addressIndex = out.address_index;
  }
  const item = { ...body, invoiceId:id, address, addressIndex, createdAt:new Date().toISOString(), status:'waiting' };
  invoices.set(id,item);
  return { address, addressIndex, mode:DEMO_MODE?'demo':'rpc', invoiceId:id };
}

async function checkInvoice(id) {
  const inv = invoices.get(id); if (!inv) return null;
  if (DEMO_MODE) return inv;
  const out = await rpc('get_transfers', { in:true, pool:true, account_index:ACCOUNT_INDEX, subaddr_indices: inv.addressIndex == null ? [] : [inv.addressIndex] });
  const transfers = [...(out.in||[]), ...(out.pool||[])];
  const expected = Math.round(Number(inv.xmrAmount||0)*1e12);
  const match = transfers.find(t => Number(t.amount) >= expected);
  if (match) { inv.status = 'paid'; inv.txid = match.txid; inv.confirmations = match.confirmations || 0; }
  return inv;
}

async function refund(body) {
  const amountAtomic = Math.round(Number(body.xmrAmount) * 1e12);
  if (!body.address || !amountAtomic) throw new Error('address and xmrAmount are required');
  if (DEMO_MODE) return { txid:randomHex(32), mode:'demo' };
  const out = await rpc('transfer', { account_index:ACCOUNT_INDEX, destinations:[{address:body.address,amount:amountAtomic}] });
  return { txid:out.tx_hash, feeAtomic:out.fee, mode:'rpc' };
}

const server = http.createServer(async (req,res)=>{
  if(req.method==='OPTIONS') return json(res,204,{});
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if(req.method==='GET' && url.pathname==='/api/health') return json(res,200,{ok:true,mode:DEMO_MODE?'demo':'rpc'});
    if(req.method==='POST' && url.pathname==='/api/invoices') return json(res,201,await createInvoice(await readBody(req)));
    if(req.method==='GET' && url.pathname.startsWith('/api/invoices/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const out = await checkInvoice(id); return out ? json(res,200,out) : json(res,404,{error:'invoice not found'});
    }
    if(req.method==='POST' && url.pathname==='/api/refunds') return json(res,200,await refund(await readBody(req)));
    return json(res,404,{error:'not found'});
  } catch (e) { return json(res,500,{error:e.message}); }
});
server.listen(PORT,()=>console.log(`XMR Tap backend on http://localhost:${PORT} (${DEMO_MODE?'demo':'rpc'} mode)`));
