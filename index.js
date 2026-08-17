import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import { buildDatastoreDevice, isPollDue, readDatastore } from './src/datastores.js';
import { ProxmoxClient } from './src/proxmox.js';

const gladys = new GladysIntegration();
let config = normalizeConfig();
const datastoreByExternalId = new Map();
const lastPollAtByExternalId = new Map();

async function discover() {
  const stores = await new ProxmoxClient(config).getDatastores();
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

gladys.onScanRequest(discover);
gladys.onPoll(async (device) => {
  let store = datastoreByExternalId.get(device.external_id);
  if (!store) {
    await discover();
    store = datastoreByExternalId.get(device.external_id);
  }
  if (!store) return;

  const now = Date.now();
  if (!isPollDue(lastPollAtByExternalId.get(device.external_id), config.poll_frequency, now)) {
    return;
  }
  lastPollAtByExternalId.set(device.external_id, now);
  try {
    await gladys.publishStates(await readDatastore(gladys, store, config, now));
  } catch (error) {
    lastPollAtByExternalId.delete(device.external_id);
    throw error;
  }
});
gladys.onAction('test_connection', async () => {
  const count = await discover();
  return {
    en: `Connection successful: ${count} datastore(s) found.`,
    fr: `Connexion réussie : ${count} datastore(s) trouvé(s).`,
  };
});
gladys.onConfigUpdated(async (newConfig) => {
  config = normalizeConfig(newConfig);
  lastPollAtByExternalId.clear();
  await discover();
});
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    lastPollAtByExternalId.clear();
    await discover();
    await gladys.setConnectionStatus(true);
  } catch (error) {
    logger.error('PBS initialization failed', error);
    await gladys
      .setConnectionStatus(false, {
        en: 'Cannot connect to Proxmox Backup Server. Check configuration and logs.',
        fr: 'Connexion à Proxmox Backup Server impossible. Vérifiez la configuration et les logs.',
      })
      .catch(() => {});
  }
});
gladys.handleShutdown();
logger.info('Starting Proxmox Backup Server integration...');
gladys.connect().catch((error) => {
  logger.error('Initial connection failed', error);
  process.exit(1);
});
