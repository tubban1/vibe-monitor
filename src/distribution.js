// This is a legacy release-contract boundary, NOT a subscription or plan flag.
// The audited open client is ONE binary for Free, Pro and Team. Cloud enforces
// account-level grants and premium service quotas on authenticated APIs.
// Existing private-beta installs retain their original activation/consent terms.
import {fetchCommunityCloudPolicy} from "./community-cloud-policy.js";
import path from "node:path";
import {safeJsonRead,vibeHome} from "./utils.js";
export const DISTRIBUTION_MODE = "open-client";
export function isOpenClientDistribution(mode=DISTRIBUTION_MODE){
 return mode==="open-client";
}
// This is a product-level access check, not a claim that local uploads have
// already reached Cloud. The public client must refuse Free analysis whenever
// the user stops the required telemetry service. No scan is performed here.
export function freeAnalysisContractStatus(){
 const cfg=safeJsonRead(path.join(vibeHome(),"free-telemetry","config.json"),null);
 const telemetryEnabled=cfg?.enabled===true;
 const architectureProfileEnabled=cfg?.dataIntelligenceDecision!=="declined";
 return {serviceEnabled:telemetryEnabled&&architectureProfileEnabled,
  telemetryRequired:true,telemetryEnabled,
  architectureProfileRequired:true,
  reason:telemetryEnabled&&architectureProfileEnabled?null:"telemetry_required",
  nextAction:"vibe-monitor telemetry on"};
}

export async function resolveDistributionPolicy({
 mode=DISTRIBUTION_MODE,fetchPolicy,force=false
}={}){
 // Public tuning is a safe baseline shared by Free/Pro/Team, NOT plan access.
 // Paid entitlements must be decided and enforced in authenticated Cloud APIs.
 if(mode==="open-client"){
  const access=freeAnalysisContractStatus();
  if(!access.serviceEnabled)return {enabled:false,source:"free-service-contract",
   reason:"telemetry_required",profile:"free",version:"free-contract-v1",
   update:{enabled:false},config:null};
  return fetchCommunityCloudPolicy({force});
 }
 if(mode==="private-beta"&&typeof fetchPolicy==="function")
  return fetchPolicy({force});
 throw new TypeError("invalid_distribution_policy");
}
