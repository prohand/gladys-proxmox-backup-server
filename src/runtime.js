import { logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { buildDatastoreDevice, isPollDue, readDatastore } from './datastores.js';
import { ProxmoxClient } from './proxmox.js';

export const START_RETRY_ATTEMPTS = 4;
export const START_RETRY_BASE_DELAY_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The whole integration lifecycle, with its dependencies injected so it can be
 * exercised without a Gladys instance or a reachable PBS. `index.js` only wires
 * this to the SDK.
 */
export function createRuntime(gladys, dependencies = {}) {
  const {
    listDatastores = (config) => new ProxmoxClient(config).getDatastores(),
    readStates = readDatastore,
    now = () => Date.now(),
    wait = sleep,
    retryAttempts = START_RETRY_ATTEMPTS,
    retryBaseDelayMs = START_RETRY_BASE_DELAY_MS,
  } = dependencies;

  let config = normalizeConfig();
  const datastoreByExternalId = new Map();
  const lastPollAtByExternalId = new Map();

  async function discover() {
    const stores = await listDatastores(config);
    const devices = stores.map((store) => buildDatastoreDevice(gladys, store));
    datastoreByExternalId.clear();
    devices.forEach((device, index) =>
      datastoreByExternalId.set(device.external_id, stores[index].store),
    );
    for (const externalId of lastPollAtByExternalId.keys()) {
      if (!datastoreByExternalId.has(externalId)) lastPollAtByExternalId.delete(externalId);
    }
    await gladys.publishDiscoveredDevices(devices);
    return stores.length;
  }

  async function poll(device) {
    let store = datastoreByExternalId.get(device.external_id);
    if (!store) {
      await discover();
      store = datastoreByExternalId.get(device.external_id);
    }
    if (!store) return;

    // Gladys polls every minute (the only accepted frequency); this gate turns
    // that into the user-configured refresh interval.
    const startedAt = now();
    if (
      !isPollDue(lastPollAtByExternalId.get(device.external_id), config.poll_frequency, startedAt)
    )
      return;
    lastPollAtByExternalId.set(device.external_id, startedAt);
    try {
      await gladys.publishStates(await readStates(gladys, store, config, startedAt));
    } catch (error) {
      // Forget the timestamp so the next tick retries instead of waiting a full
      // refresh interval after a transient failure.
      lastPollAtByExternalId.delete(device.external_id);
      throw error;
    }
  }

  async function testConnection() {
    const count = await discover();
    return {
      en: `Connection successful: ${count} datastore(s) found.`,
      fr: `Connexion réussie : ${count} datastore(s) trouvé(s).`,
    };
  }

  async function updateConfig(newConfig) {
    config = normalizeConfig(newConfig);
    lastPollAtByExternalId.clear();
    await discover();
  }

  async function start() {
    let lastError;
    for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
      try {
        await updateConfig(await gladys.getConfig());
        await gladys.setConnectionStatus(true);
        return true;
      } catch (error) {
        lastError = error;
        logger.error(`PBS initialization failed (attempt ${attempt + 1}/${retryAttempts})`, error);
        if (attempt < retryAttempts - 1) await wait(retryBaseDelayMs * 2 ** attempt);
      }
    }
    logger.error('PBS initialization gave up after all retries', lastError);
    await gladys
      .setConnectionStatus(false, {
        en: 'Cannot connect to Proxmox Backup Server. Check configuration and logs.',
        fr: 'Connexion à Proxmox Backup Server impossible. Vérifiez la configuration et les logs.',
      })
      .catch(() => {});
    return false;
  }

  return {
    discover,
    poll,
    testConnection,
    updateConfig,
    start,
    getConfig: () => config,
  };
}

export function registerRuntime(gladys, runtime = createRuntime(gladys)) {
  gladys.onScanRequest(() => runtime.discover());
  gladys.onPoll((device) => runtime.poll(device));
  gladys.onAction('test_connection', () => runtime.testConnection());
  gladys.onConfigUpdated((newConfig) => runtime.updateConfig(newConfig));
  gladys.on('connected', () => runtime.start());
  return runtime;
}
