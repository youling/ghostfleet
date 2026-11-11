/** Optional launcher source; importing it never enrolls or contacts a provider. */
export {BOOTSTRAP_SH} from "./bootstrap.js";
export {CONVERGENCE_PHASES, COMPONENT_STATES, detectSystemFacts, classifyComponents, planConvergence, sanitizeCheckpoint, isSecretFreeCheckpoint} from "./convergence.js";
export {createEnrollmentTicketStore} from "./ticket.js";
export {evaluateBootstrapPreflight} from "./preflight.js";
export {planManagedLinuxInstallation} from "./management-plan.js";
export {
  SELECTED_CAPABILITY_SCHEMA, CAPABILITY_BLOCK_BEGIN, CAPABILITY_BLOCK_END,
  CAPABILITY_SECTION_BEGIN, CAPABILITY_SECTION_END,
  selectedCapabilitiesFromPosture, normalizeSelectedCapability, renderCapabilityBlock, capabilityDigest,
} from "./capability.js";
export {createBootstrapSession, recordRootCeremony, attachPreflight, attachClaim, completeBootstrap, assertNoPostBootstrapPasswordPrompt, createBootstrapReceipt} from "./session.js";
import {BOOTSTRAP_SH} from "./bootstrap.js";
import {CAPABILITY_BLOCK_BEGIN, CAPABILITY_BLOCK_END, renderCapabilityBlock} from "./capability.js";

/**
 * Render only deployment-supplied coordinates; never perform an enrollment.
 *
 * `capabilitySelection` is the reviewed template's selected capability. When it
 * is omitted the courier keeps its immutable default block, which installs no
 * privileged component. When it is supplied, the pinned artifact version and
 * SHA-256 digests travel inside the same first-root payload.
 */
export function renderBootstrap({brokerOrigin,checkpointDir="/var/lib/fleet",capabilitySelection=null}) {
  let parsed;
  try {parsed=new URL(brokerOrigin);} catch {throw new Error("BOOTSTRAP_ORIGIN_REQUIRED");}
  if(parsed.protocol!=="https:" || parsed.origin!==brokerOrigin || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("BOOTSTRAP_ORIGIN_INVALID");
  if(typeof checkpointDir!=="string" || !checkpointDir.startsWith("/") || checkpointDir.split("/").includes("..") || checkpointDir.includes("\0") || /[\r\n]/.test(checkpointDir)) throw new Error("BOOTSTRAP_PATH_INVALID");
  const quoted=value=>"'" + value.replaceAll("'","'\\''") + "'";
  const block=renderCapabilityBlock(capabilitySelection);
  const begin=BOOTSTRAP_SH.indexOf(CAPABILITY_BLOCK_BEGIN);
  const end=BOOTSTRAP_SH.indexOf(CAPABILITY_BLOCK_END,begin);
  // The published courier is also served verbatim, so a payload without the
  // sentinels is a build error rather than a silently unselected capability.
  if(begin<0||end<begin) throw new Error("BOOTSTRAP_CAPABILITY_BLOCK_MISSING");
  const head=BOOTSTRAP_SH.slice(0,begin+CAPABILITY_BLOCK_BEGIN.length+1);
  const tail=BOOTSTRAP_SH.slice(end);
  return (head+block+"\n"+tail)
    .replace('BROKER_ORIGIN="${GHOSTFLEET_BROKER_ORIGIN:-}"',"BROKER_ORIGIN="+quoted(brokerOrigin))
    .replace('CHECKPOINT_DIR="${GHOSTFLEET_CHECKPOINT_DIR:-/var/lib/fleet}"',"CHECKPOINT_DIR="+quoted(checkpointDir));
}
