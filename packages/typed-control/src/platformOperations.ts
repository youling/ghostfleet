import { Buffer } from "buffer";
import type { NodePolicy } from "./controlPolicy.js";

export type Observation = "identity" | "disk" | "memory" | "uptime";
const linux: Record<Observation,string> = {
  identity: "/usr/bin/id",
  disk: "LC_ALL=C /usr/bin/df -Pk",
  memory: "LC_ALL=C /usr/bin/free -b",
  uptime: "/usr/bin/cat /proc/uptime",
};
const windows: Record<Observation,string> = {
  identity: "[Security.Principal.WindowsIdentity]::GetCurrent().Name",
  disk: "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress",
  memory: "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress",
  uptime: "Get-CimInstance Win32_OperatingSystem | Select-Object LastBootUpTime,LocalDateTime | ConvertTo-Json -Compress",
};
function powershell(script: string): string {
  // Accepted Windows adapter uses the PowerShell 7 default SSH shell. Run
  // fixed code in a fresh non-interactive/no-profile process. No caller script.
  const encoded = Buffer.from(`$ErrorActionPreference='Stop'; ${script}`, "utf16le").toString("base64");
  return `& 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}
export function observationCommand(node: NodePolicy, observation: Observation): string {
  if (!node.observations.includes(observation)) throw new Error("CAPABILITY_NOT_ALLOWED");
  return node.platform === "linux" ? linux[observation] : powershell(windows[observation]);
}
export function serviceCommand(node: NodePolicy, key: string, restart: boolean): string {
  const service = Object.hasOwn(node.services,key) ? node.services[key] : undefined;
  if (!service) throw new Error("SERVICE_NOT_ALLOWED");
  if (restart && (!service.restart_allowed || node.platform !== "linux" || node.execution_privilege !== "normal")) {
    throw new Error("SERVICE_RESTART_NOT_ALLOWED");
  }
  // Unit comes from validated server policy, never directly from tool input.
  // The Linux adapter only addresses user units; no sudo/system unit seam.
  if (node.platform === "linux") return restart
    ? `/usr/bin/systemctl --user restart -- '${service.unit}'`
    : `/usr/bin/systemctl --user show --no-pager --property=Id,LoadState,ActiveState,SubState,Result -- '${service.unit}'`;
  return powershell(`Get-Service -Name '${service.unit}' | Select-Object Name,Status,StartType | ConvertTo-Json -Compress`);
}
