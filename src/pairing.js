import {emitKeypressEvents} from 'node:readline';
import {isOpenClientDistribution} from './distribution.js';

// Public-client-compatible helper. Only the verified local installation
// credential goes into the Authorization header; code is not in argv or URL.
const CODE=/^[a-f0-9]{64}$/i;
const OFFICIAL='https://vibe-api.fde.fan';

export async function acceptAccountPairing({client,code,fetchImpl=fetch,timeoutMs=8000}={}){
 if(isOpenClientDistribution())return {accepted:false,reason:'legacy_beta_pairing_disabled'};
 if(typeof code!=='string'||!CODE.test(code))
   return {accepted:false,reason:'invalid_pairing_code'};
 if(!client?.token||!client?.baseUrl)
   return {accepted:false,reason:'cloud_not_registered'};
 let endpoint;
 try{
  const base=new URL(client.baseUrl);
  // Never send the Beta bearer token to a user-controlled URL.
  if(base.origin!==OFFICIAL||base.username||base.password)
   return {accepted:false,reason:'unsupported_pairing_host'};
  endpoint=new URL('/api/portal/v1/pairing-intents/accept',base.origin);
 }catch{return {accepted:false,reason:'invalid_cloud_url'};}
 try{
  const result=await fetchImpl(endpoint,{
   method:'POST',redirect:'error',
   headers:{'authorization':'Bearer '+client.token,
    'content-type':'application/json','cache-control':'no-store'},
   body:JSON.stringify({pairingCode:code.toLowerCase()}),
   signal:AbortSignal.timeout(timeoutMs)
  });
  if(result.status===200)return {accepted:true,status:'waiting_for_web_confirmation'};
  if(result.status===409)return {accepted:false,reason:'invalid_or_used_pairing_code'};
  if(result.status===401)return {accepted:false,reason:'installation_not_authorized'};
  if(result.status===429)return {accepted:false,reason:'rate_limited'};
  return {accepted:false,reason:'pairing_unavailable'};
 }catch{return {accepted:false,reason:'pairing_unavailable'};}
}

// TTY-only no-echo entry. No --code command argument (process lists/history),
// no clipboard reads, no persistence, no diagnostic logging of the raw code.
export async function readMaskedPairingCode({input=process.stdin,output=process.stdout}={}){
 if(!input.isTTY||!output.isTTY||typeof input.setRawMode!=='function')
  throw new Error('interactive_terminal_required');
 emitKeypressEvents(input);
 output.write('Paste the 64-character pairing code (input hidden): ');
 const prior=input.isRaw===true;
 return new Promise((resolve,reject)=>{
  let code='';
  const finish=(error)=>{
   input.off('keypress',press);
   input.setRawMode(prior);
   input.pause();
   output.write('\n');
   if(error)reject(error);
   else resolve(code);
  };
  const press=(char,key)=>{
   if(key?.ctrl&&key.name==='c'){finish(new Error('pairing_cancelled'));return;}
   if(key?.name==='return'||key?.name==='enter'){
    if(CODE.test(code))finish();
    else finish(new Error('invalid_pairing_code'));
    return;
   }
   if(key?.name==='backspace'){code=code.slice(0,-1);return;}
   if(typeof char==='string'&&/^[0-9a-f]+$/i.test(char)&&code.length+char.length<=64)code+=char;
  };
  input.on('keypress',press);
  input.setRawMode(true);input.resume();
 });
}
