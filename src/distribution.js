// This is a legacy release-contract boundary, NOT a subscription or plan flag.
// The audited open client is ONE binary for Free, Pro and Team. Cloud enforces
// account-level grants and premium service quotas on authenticated APIs.
// Existing private-beta installs retain their original activation/consent terms.
import {fetchCommunityCloudPolicy} from "./community-cloud-policy.js";
export const DISTRIBUTION_MODE = "open-client";
export function isOpenClientDistribution(mode=DISTRIBUTION_MODE){
 return mode==="open-client";
}
export async function resolveDistributionPolicy({
 mode=DISTRIBUTION_MODE,fetchPolicy,force=false
}={}){
 // Public tuning is a safe baseline shared by Free/Pro/Team, NOT plan access.
 // Paid entitlements must be decided and enforced in authenticated Cloud APIs.
 if(mode==="open-client")return fetchCommunityCloudPolicy({force});
 if(mode==="private-beta"&&typeof fetchPolicy==="function")
  return fetchPolicy({force});
 throw new TypeError("invalid_distribution_policy");
}
