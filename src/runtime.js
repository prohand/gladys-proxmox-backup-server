import { logger } from '@gladysassistant/integration-sdk';
import { withPullDeadline } from './widgetDeadline.js';
import { normalizeConfig } from './config.js';
import {
  buildDatastoreDevice,
  DatastoreMissingError,
  datastoreStates,
  isPollDue,
  readDatastore,
} from './datastores.js';
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
// `/status/datastore-usage` lists every datastore at once: the reads of one
// Gladys tick (it polls every device within the same minute) share one answer.
export const USAGE_SHARE_MS = 30_000;
// A device whose datastore PBS no longer lists is looked up again after one
// refresh interval, then twice as long each time, up to a day.
export const MISSING_LOOKUP_MAX_MS = 24 * 60 * 60 * 1000;

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
  // Last discovery an unknown external_id asked for, and the delay before the next one: a
  // datastore deleted on PBS while its device lives on in Gladys must not cost a full discovery on
  // every one-minute poll, and the delay grows while it stays missing.
  const lookupAtByUnknownId = new Map();
  // The read in progress per device: a widget, a scene action and a poll asking at the same time
  // share it instead of reading PBS two or three times over.
  const inFlightByExternalId = new Map();
  // Bumped on every configuration change: a read started for the previous server must not land
  // in the caches of the new one.
  let generation = 0;
  let usageRead = null;
  // Datastores whose last read failed, and the status last reported to Gladys. The status used to
  // be written by start() alone: a PBS that booted after Gladys stayed red for good, and one that
  // went down later stayed green.
  const failingExternalIds = new Map();
  let reportedConnected = null;

  // One `/status/datastore-usage` answer shared by the reads of a refresh;
  // `force` (discovery) always asks PBS and seeds the share.
  function readUsage(force = false) {
    if (!force && usageRead && now() - usageRead.at < USAGE_SHARE_MS) return usageRead.promise;
    const entry = { at: now(), promise: Promise.resolve().then(() => listDatastores(config)) };
    usageRead = entry;
    entry.promise.catch(() => {
      if (usageRead === entry) usageRead = null;
    });
    return entry.promise;
  }

  async function discover() {
    const stores = await readUsage(true);
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
    // A device found again stops backing off. One still missing keeps its delay.
    for (const externalId of lookupAtByUnknownId.keys())
      if (datastoreByExternalId.has(externalId)) lookupAtByUnknownId.delete(externalId);
    // A datastore removed from PBS no longer counts as failing: left there, its last error kept
    // the status red forever, although PBS itself answers.
    let purged = false;
    for (const externalId of failingExternalIds.keys()) {
      if (!datastoreByExternalId.has(externalId)) {
        failingExternalIds.delete(externalId);
        purged = true;
      }
    }
    if (purged) await syncStatus();
    await gladys.publishDiscoveredDevices(devices);
    return stores.length;
  }

  function noteMissing(externalId) {
    const base = config.poll_frequency * 1000;
    const previous = lookupAtByUnknownId.get(externalId);
    lookupAtByUnknownId.set(externalId, {
      at: now(),
      delayMs: previous ? Math.min(previous.delayMs * 2, MISSING_LOOKUP_MAX_MS) : base,
    });
  }

  async function resolveStore(externalId) {
    if (!datastoreByExternalId.has(externalId)) {
      const lookup = lookupAtByUnknownId.get(externalId);
      if (lookup === undefined || now() - lookup.at >= lookup.delayMs) {
        // Stamped before the discovery, at the current delay: a PBS that is down retries at the
        // refresh interval, it is only a datastore PBS answered without that backs off.
        lookupAtByUnknownId.set(externalId, {
          at: now(),
          delayMs: lookup?.delayMs ?? config.poll_frequency * 1000,
        });
        await discover();
        if (!datastoreByExternalId.has(externalId) && lookup) noteMissing(externalId);
      }
    }
    return datastoreByExternalId.get(externalId);
  }

  // The user-facing reason of a failure, in both languages.
  function reasonOf(error) {
    const messages = error?.messages ?? { en: error?.message, fr: error?.message };
    return {
      en: String(messages.en ?? '').slice(0, 150),
      fr: String(messages.fr ?? '').slice(0, 150),
    };
  }

  async function syncStatus() {
    const connected = failingExternalIds.size === 0;
    if (connected === reportedConnected) return;
    reportedConnected = connected;
    const [firstError] = failingExternalIds.values();
    const reason = reasonOf(firstError);
    await gladys
      .setConnectionStatus(
        connected,
        connected
          ? undefined
          : {
              en: `Proxmox Backup Server unreachable: ${reason.en}`,
              fr: `Proxmox Backup Server injoignable : ${reason.fr}`,
            },
      )
      .catch((statusError) => logger.warn(`Status not reported: ${statusError.message}`));
  }

  async function reportReadOutcome(externalId, error) {
    if (error) failingExternalIds.set(externalId, error);
    else failingExternalIds.delete(externalId);
    await syncStatus();
  }

  // Read one datastore now and publish its states: the only path to PBS for a
  // poll, a widget, and a scene action alike. Concurrent callers share one
  // read. A PBS failure rejects; a Gladys failure to store the states does
  // not — PBS answered — and comes back as `publishError` instead.
  function refresh(externalId, store, at = now()) {
    const pending = inFlightByExternalId.get(externalId);
    if (pending) return pending;
    const startedIn = generation;
    const promise = (async () => {
      const summary = await readSummary(store, config, at, { readUsage });
      if (startedIn !== generation) return { summary, publishError: null };
      summaryByExternalId.set(externalId, summary);
      try {
        await gladys.publishStates(datastoreStates(gladys, summary));
        return { summary, publishError: null };
      } catch (publishError) {
        logger.warn(
          `Gladys did not store the states of datastore ${store}: ${publishError.message}`,
        );
        return { summary, publishError };
      }
    })().finally(() => {
      if (inFlightByExternalId.get(externalId) === promise) inFlightByExternalId.delete(externalId);
    });
    inFlightByExternalId.set(externalId, promise);
    return promise;
  }

  async function cachedOrRefresh(externalId, store, force = false) {
    const cached = !force && summaryByExternalId.get(externalId);
    return cached || (await refresh(externalId, store)).summary;
  }

  // PBS answered without this datastore: it was removed or renamed there. A
  // discovery drops it (and its error) from what the integration watches; the
  // device left in Gladys is then looked up again ever less often.
  async function forgetMissing(externalId, error) {
    logger.warn(error.message);
    try {
      await discover();
    } catch (discoveryError) {
      logger.warn(`Discovery after a missing datastore failed: ${discoveryError.message}`);
    }
    if (!datastoreByExternalId.has(externalId)) noteMissing(externalId);
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
    let result;
    try {
      result = await refresh(externalId, store, startedAt);
    } catch (error) {
      // Forget the timestamp so the next tick retries instead of waiting a full
      // refresh interval after a transient failure.
      lastPollAtByExternalId.delete(externalId);
      if (error instanceof DatastoreMissingError) {
        await forgetMissing(externalId, error);
        return;
      }
      await reportReadOutcome(externalId, error);
      if (reachableByExternalId.get(externalId) !== false) {
        reachableByExternalId.set(externalId, false);
        await publishSceneEvents([unreachableEvent(store, externalId, error)]);
      }
      throw error;
    }
    const { summary, publishError } = result;
    // PBS answered: whatever Gladys did with the states, PBS is reachable.
    await reportReadOutcome(externalId, null);
    if (publishError) {
      // Retried on the next tick. No scene event either: the baseline stays
      // where it was, so the change is reported once the states are stored.
      lastPollAtByExternalId.delete(externalId);
      const message = `Gladys did not store the states of datastore ${store}`;
      throw new Error(`${message}: ${publishError.message}`, { cause: publishError });
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

  // Gladys drops states sent for a device that does not exist yet: a device
  // just created from the Discovery screen is read now, not at the next refresh.
  async function deviceCreated(device) {
    lastPollAtByExternalId.delete(device.external_id);
    try {
      await poll(device);
    } catch (error) {
      logger.warn(`First read of the new device ${device.external_id} failed: ${error.message}`);
    }
  }

  async function datastoreWidget({ settings = {} } = {}) {
    const externalId = settings.datastore;
    const store = externalId && (await resolveStore(externalId));
    if (!store) return missingDatastoreContent();
    // Absent on widgets added before the setting existed: tiles stay shown.
    const showTiles = settings.show_tiles !== false && settings.show_tiles !== 'false';
    return datastoreWidgetContent(gladys, await cachedOrRefresh(externalId, store), {
      showTiles,
    });
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
    let count;
    try {
      count = await discover();
    } catch (error) {
      // A thrown action reaches the Configuration screen as plain text: both
      // languages travel in one string.
      const { en, fr } = error?.messages ?? { en: error?.message, fr: error?.message };
      throw new Error(en === fr ? en : `${en} / ${fr}`, { cause: error });
    }
    return {
      en: `Connection successful: ${count} datastore(s) found.`,
      fr: `Connexion réussie : ${count} datastore(s) trouvé(s).`,
    };
  }

  async function updateConfig(newConfig) {
    config = normalizeConfig(newConfig);
    // Another server or another date format: nothing read before still holds.
    generation += 1;
    usageRead = null;
    inFlightByExternalId.clear();
    lastPollAtByExternalId.clear();
    summaryByExternalId.clear();
    baselineByExternalId.clear();
    reachableByExternalId.clear();
    lookupAtByUnknownId.clear();
    failingExternalIds.clear();
    await discover();
  }

  async function start() {
    let lastError;
    for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
      try {
        await updateConfig(await gladys.getConfig());
        await gladys.setConnectionStatus(true);
        reportedConnected = true;
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
    reportedConnected = false;
    return false;
  }

  return {
    discover,
    poll,
    deviceCreated,
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
  gladys.onDeviceCreated((device) => runtime.deviceCreated(device));
  gladys.onAction('test_connection', () => runtime.testConnection());
  // Raced against a deadline: a slow PBS gives a loading card instead of a card
  // the core gives up on for good after 15 s (src/widgetDeadline.js).
  gladys.onWidgetGet(WIDGETS.DATASTORE, (request) =>
    withPullDeadline(() => runtime.datastoreWidget(request)),
  );
  gladys.onWidgetGet(WIDGETS.OVERVIEW, () => withPullDeadline(() => runtime.overviewWidget()));
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
