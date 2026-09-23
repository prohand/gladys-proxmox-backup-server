import { logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { buildDatastoreDevice, datastoreStates, isPollDue, readDatastore } from './datastores.js';
import { ProxmoxClient } from './proxmox.js';
import {
  backupReportOutputs,
  datastoreStatusOutputs,
  detectSceneEvents,
  reachableEvent,
  SCENE_ACTIONS,
  unreachableEvent,
} from './scenes.js';
import {
  datastoreWidgetContent,
  missingDatastoreContent,
  overviewWidgetContent,
  WIDGET_ACTIONS,
  WIDGETS,
} from './widgets.js';

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
    readSummary = readDatastore,
    now = () => Date.now(),
    wait = sleep,
    retryAttempts = START_RETRY_ATTEMPTS,
    retryBaseDelayMs = START_RETRY_BASE_DELAY_MS,
  } = dependencies;

  let config = normalizeConfig();
  const datastoreByExternalId = new Map();
  const lastPollAtByExternalId = new Map();
  // Last summary read per device, served to the widgets and the scene actions.
  const summaryByExternalId = new Map();
  // Last summary read by a SCHEDULED poll: the scene triggers compare against
  // it, so a refresh asked by a scene or a widget never fires an event itself.
  const baselineByExternalId = new Map();
  const reachableByExternalId = new Map();

  async function discover() {
    const stores = await listDatastores(config);
    const devices = stores.map((store) => buildDatastoreDevice(gladys, store));
    datastoreByExternalId.clear();
    devices.forEach((device, index) =>
      datastoreByExternalId.set(device.external_id, stores[index].store),
    );
    for (const map of [
      lastPollAtByExternalId,
      summaryByExternalId,
      baselineByExternalId,
      reachableByExternalId,
    ]) {
      for (const externalId of map.keys()) {
        if (!datastoreByExternalId.has(externalId)) map.delete(externalId);
      }
    }
    await gladys.publishDiscoveredDevices(devices);
    return stores.length;
  }

  async function resolveStore(externalId) {
    if (!datastoreByExternalId.has(externalId)) await discover();
    return datastoreByExternalId.get(externalId);
  }

  // Read one datastore now and publish its states: the only path to PBS for a
  // poll, a widget, and a scene action alike.
  async function refresh(externalId, store, at = now()) {
    const summary = await readSummary(store, config, at);
    summaryByExternalId.set(externalId, summary);
    await gladys.publishStates(datastoreStates(gladys, summary));
    return summary;
  }

  async function cachedOrRefresh(externalId, store, force = false) {
    return (!force && summaryByExternalId.get(externalId)) || refresh(externalId, store);
  }

  // A scene event or a widget nudge that fails must never fail the refresh
  // that produced it: the states are already published.
  async function publishSceneEvents(events) {
    for (const { key, data } of events) {
      try {
        await gladys.publishSceneEvent(key, data);
      } catch (error) {
        logger.warn(`Scene event ${key} was not accepted by Gladys: ${error.message}`);
      }
    }
  }

  function nudgeWidgets() {
    for (const key of Object.values(WIDGETS)) {
      try {
        gladys.requestWidgetRefresh(key);
      } catch (error) {
        logger.warn(`Widget ${key} refresh request failed: ${error.message}`);
      }
    }
  }

  async function poll(device) {
    const externalId = device.external_id;
    const store = await resolveStore(externalId);
    if (!store) return;

    // Gladys polls every minute (the only accepted frequency); this gate turns
    // that into the user-configured refresh interval.
    const startedAt = now();
    if (!isPollDue(lastPollAtByExternalId.get(externalId), config.poll_frequency, startedAt))
      return;
    lastPollAtByExternalId.set(externalId, startedAt);
    let summary;
    try {
      summary = await refresh(externalId, store, startedAt);
    } catch (error) {
      // Forget the timestamp so the next tick retries instead of waiting a full
      // refresh interval after a transient failure.
      lastPollAtByExternalId.delete(externalId);
      if (reachableByExternalId.get(externalId) !== false) {
        reachableByExternalId.set(externalId, false);
        await publishSceneEvents([unreachableEvent(store, externalId, error)]);
      }
      throw error;
    }
    const events = detectSceneEvents(baselineByExternalId.get(externalId), summary, externalId);
    if (reachableByExternalId.get(externalId) === false)
      events.unshift(reachableEvent(store, externalId));
    reachableByExternalId.set(externalId, true);
    baselineByExternalId.set(externalId, summary);
    await publishSceneEvents(events);
    nudgeWidgets();
  }

  // Every known datastore, from memory unless `force`; a datastore PBS does not
  // answer for is reported in `failures` instead of failing the whole list.
  async function readAll(force = false) {
    if (datastoreByExternalId.size === 0) await discover();
    const entries = [...datastoreByExternalId.entries()];
    const results = await Promise.allSettled(
      entries.map(([externalId, store]) => cachedOrRefresh(externalId, store, force)),
    );
    const summaries = [];
    const failures = new Map();
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') summaries.push(result.value);
      else failures.set(entries[index][1], result.reason);
    });
    return { summaries, failures };
  }

  async function datastoreWidget({ settings = {} } = {}) {
    const externalId = settings.datastore;
    const store = externalId && (await resolveStore(externalId));
    if (!store) return missingDatastoreContent();
    return datastoreWidgetContent(gladys, await cachedOrRefresh(externalId, store));
  }

  async function overviewWidget() {
    const { summaries, failures } = await readAll();
    return overviewWidgetContent(summaries, failures);
  }

  // Widget buttons only re-read PBS: the core refetches the content after an
  // action, so no nudge is needed.
  async function refreshDatastoreWidget(_actionKey, _params, { settings = {} } = {}) {
    const store = settings.datastore && (await resolveStore(settings.datastore));
    if (!store) throw new Error('This datastore was not found on the Proxmox Backup Server');
    await refresh(settings.datastore, store);
    return { en: 'Datastore refreshed', fr: 'Datastore actualisé' };
  }

  async function refreshOverviewWidget() {
    const { failures } = await readAll(true);
    if (failures.size)
      return {
        en: `Refreshed, ${failures.size} datastore(s) unreachable`,
        fr: `Actualisé, ${failures.size} datastore(s) injoignable(s)`,
      };
    return { en: 'Datastores refreshed', fr: 'Datastores actualisés' };
  }

  // Scene fields arrive validated, but a boolean may still come as text.
  const isOn = (value) => value === true || value === 'true';

  async function getDatastoreStatus(fields = {}) {
    const store = fields.datastore && (await resolveStore(fields.datastore));
    if (!store) throw new Error(`Unknown PBS datastore device: ${fields.datastore}`);
    return datastoreStatusOutputs(
      await cachedOrRefresh(fields.datastore, store, isOn(fields.refresh)),
    );
  }

  async function getBackupReport(fields = {}) {
    const { summaries, failures } = await readAll(isOn(fields.refresh));
    return backupReportOutputs(summaries, failures, fields.language === 'fr' ? 'fr' : 'en');
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
    // Another server or another date format: nothing read before still holds.
    lastPollAtByExternalId.clear();
    summaryByExternalId.clear();
    baselineByExternalId.clear();
    reachableByExternalId.clear();
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
    datastoreWidget,
    overviewWidget,
    refreshDatastoreWidget,
    refreshOverviewWidget,
    getDatastoreStatus,
    getBackupReport,
    updateConfig,
    start,
    getConfig: () => config,
  };
}

export function registerRuntime(gladys, runtime = createRuntime(gladys)) {
  gladys.onScanRequest(() => runtime.discover());
  gladys.onPoll((device) => runtime.poll(device));
  gladys.onAction('test_connection', () => runtime.testConnection());
  gladys.onWidgetGet(WIDGETS.DATASTORE, (request) => runtime.datastoreWidget(request));
  gladys.onWidgetGet(WIDGETS.OVERVIEW, () => runtime.overviewWidget());
  gladys.onWidgetAction(WIDGETS.DATASTORE, (actionKey, params, context) =>
    actionKey === WIDGET_ACTIONS.REFRESH
      ? runtime.refreshDatastoreWidget(actionKey, params, context)
      : Promise.reject(new Error(`Unknown widget action: ${actionKey}`)),
  );
  gladys.onWidgetAction(WIDGETS.OVERVIEW, (actionKey) =>
    actionKey === WIDGET_ACTIONS.REFRESH
      ? runtime.refreshOverviewWidget()
      : Promise.reject(new Error(`Unknown widget action: ${actionKey}`)),
  );
  gladys.onSceneAction(SCENE_ACTIONS.GET_DATASTORE_STATUS, (fields) =>
    runtime.getDatastoreStatus(fields),
  );
  gladys.onSceneAction(SCENE_ACTIONS.GET_BACKUP_REPORT, (fields) =>
    runtime.getBackupReport(fields),
  );
  gladys.onConfigUpdated((newConfig) => runtime.updateConfig(newConfig));
  gladys.on('connected', () => runtime.start());
  return runtime;
}
