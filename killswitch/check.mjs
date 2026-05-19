/**
 * BRIDGE cloud kill-switch checker. Mirrors @bridge/killswitch.
 */

function envFlag(name) {
  const v = process.env[name];
  return v === '1' || v === 'true';
}

const KNOWN_AGENTS = ['BRIDGET', 'BEATRIX', 'CLEM', 'BASIL', 'BENSON', 'VOICE', 'INTAKE', 'SYSTEM'];
const KNOWN_CAPABILITIES = ['VOICE', 'INTAKE', 'EMAIL', 'TELEGRAM', 'CALENDAR', 'VAULT_WRITE', 'OUTBOUND'];

export function check(agent, capability) {
  if (envFlag('BRIDGE_KILL_ALL')) {
    return {
      killed: true,
      reason: 'master',
      message: 'Master kill switch is active. All BRIDGE agents are paused.',
      variable: 'BRIDGE_KILL_ALL',
    };
  }
  if (envFlag('GBRAIN_KILL_SWITCH')) {
    return {
      killed: true,
      reason: 'legacy_gbrain',
      message: 'The legacy gbrain kill switch is active. All BRIDGE agents are paused.',
      variable: 'GBRAIN_KILL_SWITCH',
    };
  }
  const agentVar = `BRIDGE_KILL_${String(agent).toUpperCase()}`;
  if (envFlag(agentVar)) {
    return {
      killed: true,
      reason: 'agent',
      message: `Agent ${agent} is paused.`,
      variable: agentVar,
    };
  }
  if (capability) {
    const capVar = `BRIDGE_KILL_${String(capability).toUpperCase()}`;
    if (envFlag(capVar)) {
      return {
        killed: true,
        reason: 'capability',
        message: `Capability ${capability} is paused.`,
        variable: capVar,
      };
    }
  }
  return { killed: false, reason: null, message: 'Clear to act.', variable: null };
}

export function snapshot() {
  const out = {
    BRIDGE_KILL_ALL: envFlag('BRIDGE_KILL_ALL') ? 'active' : 'off',
    GBRAIN_KILL_SWITCH: envFlag('GBRAIN_KILL_SWITCH') ? 'active' : 'off',
  };
  for (const a of KNOWN_AGENTS) {
    out[`BRIDGE_KILL_${a}`] = envFlag(`BRIDGE_KILL_${a}`) ? 'active' : 'off';
  }
  for (const c of KNOWN_CAPABILITIES) {
    const k = `BRIDGE_KILL_${c}`;
    if (!(k in out)) {
      out[k] = envFlag(k) ? 'active' : 'off';
    }
  }
  return out;
}

export { KNOWN_AGENTS, KNOWN_CAPABILITIES };
