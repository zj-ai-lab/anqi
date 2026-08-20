import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function pathIsInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function filePathFromURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'file:' ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
}

function physicalFilePath(value) {
  const path = filePathFromURL(value);
  if (path === null) return null;
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function readPackageInfo(root) {
  try {
    const value = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (typeof value.name !== 'string' || !value.name) return null;
    return {
      name: value.name,
      version: typeof value.version === 'string' ? value.version : null,
    };
  } catch {
    return null;
  }
}

function readDirectDependencyNames(projectRoot) {
  if (projectRoot === null) return new Set();
  const value = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  const dependencies = value.dependencies ?? {};
  if (
    dependencies === null
    || typeof dependencies !== 'object'
    || Array.isArray(dependencies)
  ) {
    throw new Error('project package.json dependencies must be an object');
  }
  return new Set(Object.keys(dependencies));
}

function topLevelDependencyName(dependencyRoot, packageRoot) {
  if (dependencyRoot === null) return null;
  const segments = relative(dependencyRoot, packageRoot).split(sep);
  if (segments.length === 1 && segments[0] && segments[0] !== '..') return segments[0];
  if (segments.length === 2 && segments[0].startsWith('@') && segments[1]) {
    return `${segments[0]}/${segments[1]}`;
  }
  return null;
}

function dependencyPackageBoundary(filePath) {
  const root = parse(filePath).root;
  const segments = relative(root, filePath).split(sep);
  const nodeModulesIndex = segments.lastIndexOf('node_modules');
  if (nodeModulesIndex === -1) return null;
  const packageName = segments[nodeModulesIndex + 1];
  if (!packageName) return join(root, ...segments.slice(0, nodeModulesIndex + 1));
  const end = packageName.startsWith('@') ? nodeModulesIndex + 3 : nodeModulesIndex + 2;
  return join(root, ...segments.slice(0, Math.min(end, segments.length)));
}

function createPackageRootFinder() {
  const cache = new Map();
  return (filePath) => {
    const dependencyBoundary = dependencyPackageBoundary(filePath);
    if (dependencyBoundary !== null) {
      if (cache.has(dependencyBoundary)) return cache.get(dependencyBoundary);
      const info = readPackageInfo(dependencyBoundary);
      const result = info === null
        ? { packageInfo: null, errorRoot: dependencyBoundary }
        : { packageInfo: { root: dependencyBoundary, ...info }, errorRoot: null };
      cache.set(dependencyBoundary, result);
      return result;
    }

    const visited = [];
    let current = dirname(filePath);
    for (;;) {
      if (cache.has(current)) {
        const cached = cache.get(current);
        for (const directory of visited) cache.set(directory, cached);
        return cached;
      }
      visited.push(current);
      const info = readPackageInfo(current);
      if (info !== null) {
        const result = { packageInfo: { root: current, ...info }, errorRoot: null };
        for (const directory of visited) cache.set(directory, result);
        return result;
      }
      const parent = dirname(current);
      if (parent === current) {
        const result = { packageInfo: null, errorRoot: null };
        for (const directory of visited) cache.set(directory, result);
        return result;
      }
      current = parent;
    }
  };
}

function packageContentMeasurement(root) {
  let bytes = 0;
  let errors = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      errors += 1;
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name === 'node_modules') continue;
      if (entry.isDirectory() && ['.runtime', '.sessions'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      try {
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile()) bytes += lstatSync(path).size;
      } catch {
        errors += 1;
      }
    }
  }
  return { bytes, errors };
}

function loadedFileRecord(records, url) {
  const physicalPath = physicalFilePath(url);
  if (physicalPath === null) return null;
  let record = records.get(physicalPath);
  if (record === undefined) {
    record = {
      path: physicalPath,
      url: pathToFileURL(physicalPath).href,
      instances: 0,
      sourceBytes: null,
      formats: new Set(),
      observedBy: new Set(),
    };
    records.set(physicalPath, record);
  }
  return record;
}

function addLoadedFile(records, url, evidence) {
  const record = loadedFileRecord(records, url);
  if (record === null) return;
  if (evidence.countInstance === true) record.instances += 1;
  record.observedBy.add(evidence.observedBy);
  if (typeof evidence.format === 'string') record.formats.add(evidence.format);
  if (Number.isSafeInteger(evidence.sourceBytes) && evidence.sourceBytes >= 0) {
    record.sourceBytes = record.sourceBytes === null
      ? evidence.sourceBytes
      : Math.max(record.sourceBytes, evidence.sourceBytes);
  }
}

const MAX_EVENT_TEXT_BYTES = 4 * 1024;
const COMMON_EVENT_KEYS = ['v', 'pid', 'tid', 'seq', 'event'];
const MODULE_PROTOCOLS = new Set(['data:', 'file:', 'node:']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isBoundedText(value) {
  return typeof value === 'string' && Buffer.byteLength(value) <= MAX_EVENT_TEXT_BYTES;
}

function isNullable(value, predicate) {
  return value === null || predicate(value);
}

function hasEventKeys(event, required = [], optional = []) {
  const allowed = new Set([...COMMON_EVENT_KEYS, ...required, ...optional]);
  return required.every((key) => Object.hasOwn(event, key))
    && Object.keys(event).every((key) => allowed.has(key));
}

function isModuleURL(value, { nullable = false, fileOnly = false } = {}) {
  if (nullable && value === null) return true;
  if (!isBoundedText(value) || value.includes('[REDACTED]')) return false;
  if (value === 'data:') return !fileOnly;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'file:') {
      try {
        if (fileURLToPath(url).includes('[REDACTED]')) return false;
      } catch {
        return false;
      }
    }
    return fileOnly ? url.protocol === 'file:' : MODULE_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

function hasValidCommonFields(event) {
  return isRecord(event)
    && event.v === 1
    && isNonNegativeInteger(event.pid)
    && isNonNegativeInteger(event.tid)
    && Number.isSafeInteger(event.seq)
    && event.seq > 0
    && isBoundedText(event.event);
}

function hasValidTraceEvent(event) {
  switch (event.event) {
    case 'trace.start':
      return hasEventKeys(event, ['node', 'ppid', 'entryURL', 'tracePath'])
        && isBoundedText(event.node)
        && isNonNegativeInteger(event.ppid)
        && isModuleURL(event.entryURL, { nullable: true, fileOnly: true })
        && isModuleURL(event.tracePath, { fileOnly: true });
    case 'trace.exit':
      return hasEventKeys(event);
    case 'trace.dropped':
      return hasEventKeys(event, ['reason', 'maxBytes'])
        && event.reason === 'per-file-byte-limit'
        && Number.isSafeInteger(event.maxBytes)
        && event.maxBytes > 0;
    case 'esm.resolve':
      return hasEventKeys(
        event,
        ['specifier', 'parentURL', 'resolvedURL', 'format', 'conditions'],
      )
        && isBoundedText(event.specifier)
        && isModuleURL(event.parentURL, { nullable: true })
        && isModuleURL(event.resolvedURL)
        && isNullable(event.format, isBoundedText)
        && Array.isArray(event.conditions)
        && event.conditions.length <= 64
        && event.conditions.every(isBoundedText);
    case 'cjs.resolve':
      return hasEventKeys(
        event,
        ['cjsLoadId', 'specifier', 'parentURL', 'parentId', 'resolvedURL', 'isMain'],
      )
        && isNullable(event.cjsLoadId, isBoundedText)
        && isBoundedText(event.specifier)
        && isModuleURL(event.parentURL, { nullable: true, fileOnly: true })
        && isNullable(event.parentId, isBoundedText)
        && isModuleURL(event.resolvedURL, { nullable: true })
        && typeof event.isMain === 'boolean';
    case 'cjs.resolve-error':
      return hasEventKeys(
        event,
        ['cjsLoadId', 'specifier', 'parentURL', 'parentId', 'errorName', 'errorCode'],
      )
        && isNullable(event.cjsLoadId, isBoundedText)
        && isBoundedText(event.specifier)
        && isModuleURL(event.parentURL, { nullable: true, fileOnly: true })
        && isNullable(event.parentId, isBoundedText)
        && isBoundedText(event.errorName)
        && isNullable(event.errorCode, isBoundedText);
    case 'cjs.load': {
      const commonFields = [
        'cjsLoadId',
        'specifier',
        'parentURL',
        'parentId',
        'resolvedURL',
        'isMain',
        'outcome',
      ];
      const validCommon = isBoundedText(event.cjsLoadId)
        && isBoundedText(event.specifier)
        && isModuleURL(event.parentURL, { nullable: true, fileOnly: true })
        && isNullable(event.parentId, isBoundedText)
        && isModuleURL(event.resolvedURL, { nullable: true })
        && typeof event.isMain === 'boolean';
      if (event.outcome === 'returned') {
        return hasEventKeys(event, commonFields) && validCommon;
      }
      return event.outcome === 'threw'
        && hasEventKeys(event, [...commonFields, 'errorName', 'errorCode'])
        && validCommon
        && isBoundedText(event.errorName)
        && isNullable(event.errorCode, isBoundedText);
    }
    case 'module.load':
      return hasEventKeys(event, ['url', 'format', 'sourceBytes'])
        && isModuleURL(event.url)
        && isNullable(event.format, isBoundedText)
        && (event.sourceBytes === null || isNonNegativeInteger(event.sourceBytes));
    default:
      return false;
  }
}

function parseTraceFiles(traceDirectory) {
  const files = readdirSync(traceDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(traceDirectory, entry.name))
    .sort();
  const events = [];
  let malformedLines = 0;
  let blankLines = 0;
  let recordValidationErrors = 0;
  for (const file of files) {
    const match = /^(\d+)-(\d+)\.jsonl$/u.exec(basename(file));
    const expectedPid = match === null ? null : Number(match[1]);
    const expectedTid = match === null ? null : Number(match[2]);
    if (match === null) recordValidationErrors += 1;

    const fileEvents = [];
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line) {
        blankLines += 1;
        if (lineIndex !== lines.length - 1) recordValidationErrors += 1;
        continue;
      }
      try {
        const event = JSON.parse(line);
        if (!hasValidCommonFields(event)) {
          malformedLines += 1;
          continue;
        }
        fileEvents.push(event);
        if (event.pid !== expectedPid) recordValidationErrors += 1;
        if (event.tid !== expectedTid) recordValidationErrors += 1;
        if (event.seq !== fileEvents.length) recordValidationErrors += 1;
        if (!hasValidTraceEvent(event)) {
          recordValidationErrors += 1;
          continue;
        }
        events.push(event);
      } catch {
        malformedLines += 1;
      }
    }

    if (fileEvents.length === 0) {
      recordValidationErrors += 1;
      continue;
    }
    const starts = fileEvents.filter((event) => event.event === 'trace.start');
    const exits = fileEvents.filter((event) => event.event === 'trace.exit');
    const dropped = fileEvents.filter((event) => event.event === 'trace.dropped');
    if (starts.length !== 1 || fileEvents[0].event !== 'trace.start') {
      recordValidationErrors += 1;
    }
    if (exits.length > 1 || (exits.length === 1 && fileEvents.at(-1).event !== 'trace.exit')) {
      recordValidationErrors += 1;
    }
    if (dropped.length > 1 || (dropped.length === 1 && fileEvents.at(-1).event !== 'trace.dropped')) {
      recordValidationErrors += 1;
    }
  }
  return {
    files,
    events,
    malformedLines,
    blankLines,
    recordValidationErrors,
  };
}

export function summarizeTraceDirectory(traceDirectory, options = {}) {
  if (!isAbsolute(traceDirectory)) throw new Error('trace directory must be absolute');
  const dependencyRoot = options.dependencyRoot === undefined
    ? null
    : realpathSync(resolve(options.dependencyRoot));
  const projectRoot = options.projectRoot === undefined
    ? null
    : realpathSync(resolve(options.projectRoot));
  if (options.requiredEntries !== undefined && !Array.isArray(options.requiredEntries)) {
    throw new Error('requiredEntries must be an array of absolute file paths');
  }
  const requiredEntryPaths = [...new Set((options.requiredEntries || []).map((entry) => {
    if (typeof entry !== 'string' || !isAbsolute(entry)) {
      throw new Error('requiredEntries must contain only absolute file paths');
    }
    return realpathSync(resolve(entry));
  }))].sort();
  const directDependencyNames = readDirectDependencyNames(projectRoot);
  const parsed = parseTraceFiles(traceDirectory);
  const loadedFiles = new Map();
  let esmResolveEdges = 0;
  let cjsResolveEdges = 0;
  let cjsResolveErrors = 0;
  let cjsLoadEvents = 0;
  let successfulCjsLoads = 0;
  let moduleLoadEvents = 0;
  let startRecords = 0;
  let exitRecords = 0;
  let droppedRecords = 0;
  const processEntryPaths = new Set();
  const resolutionEdges = [];

  for (const event of parsed.events) {
    if (event.event === 'trace.start') {
      startRecords += 1;
      const entryPath = physicalFilePath(event.entryURL);
      if (entryPath !== null) processEntryPaths.add(entryPath);
    } else if (event.event === 'trace.exit') exitRecords += 1;
    else if (event.event === 'trace.dropped') droppedRecords += 1;
    else if (event.event === 'esm.resolve') {
      esmResolveEdges += 1;
      resolutionEdges.push({
        kind: 'esm',
        specifier: event.specifier,
        parentURL: event.parentURL ?? null,
        resolvedURL: event.resolvedURL ?? null,
        format: event.format ?? null,
      });
    } else if (event.event === 'cjs.resolve') {
      cjsResolveEdges += 1;
      resolutionEdges.push({
        kind: 'cjs',
        specifier: event.specifier,
        parentURL: event.parentURL ?? null,
        resolvedURL: event.resolvedURL ?? null,
        format: null,
      });
    } else if (event.event === 'cjs.resolve-error') cjsResolveErrors += 1;
    else if (event.event === 'module.load') {
      moduleLoadEvents += 1;
      addLoadedFile(loadedFiles, event.url, {
        observedBy: 'module.load',
        format: event.format,
        sourceBytes: event.sourceBytes,
        countInstance: true,
      });
    } else if (event.event === 'cjs.load') {
      cjsLoadEvents += 1;
      if (event.outcome === 'returned') {
        successfulCjsLoads += 1;
        addLoadedFile(loadedFiles, event.resolvedURL, {
          observedBy: 'cjs.load',
          format: 'commonjs',
          sourceBytes: null,
          countInstance: false,
        });
      }
    }
  }

  const findPackageRoot = createPackageRootFinder();
  const packages = new Map();
  const packageResolutionErrorRoots = new Set();
  let observedSourceBytes = 0;
  let statFallbackBytes = 0;
  let unknownByteFiles = 0;
  for (const file of loadedFiles.values()) {
    if (file.instances === 0 && file.observedBy.has('cjs.load')) file.instances = 1;
    let measuredBytes;
    let byteSource;
    if (file.sourceBytes !== null) {
      measuredBytes = file.sourceBytes;
      observedSourceBytes += measuredBytes;
      byteSource = 'loader-source';
    } else {
      try {
        measuredBytes = statSync(file.path).size;
        statFallbackBytes += measuredBytes;
        byteSource = 'post-exit-stat';
      } catch {
        measuredBytes = null;
        unknownByteFiles += 1;
        byteSource = 'unknown';
      }
    }
    file.measuredBytes = measuredBytes;
    file.byteSource = byteSource;

    const packageLookup = findPackageRoot(file.path);
    if (packageLookup.errorRoot !== null) {
      packageResolutionErrorRoots.add(packageLookup.errorRoot);
    }
    const packageInfo = packageLookup.packageInfo;
    if (packageInfo === null) continue;
    let packageRecord = packages.get(packageInfo.root);
    if (packageRecord === undefined) {
      const dependency = dependencyRoot !== null
        && pathIsInside(dependencyRoot, packageInfo.root);
      const topLevelName = dependency
        ? topLevelDependencyName(dependencyRoot, packageInfo.root)
        : null;
      packageRecord = {
        name: packageInfo.name,
        version: packageInfo.version,
        root: packageInfo.root,
        rootURL: pathToFileURL(packageInfo.root).href,
        dependency,
        topLevelName,
        directDependency: topLevelName !== null && directDependencyNames.has(topLevelName),
        loadedFiles: new Set(),
        loadInstances: 0,
        loadedFileBytes: 0,
        unknownByteFiles: 0,
        reachEvidence: [],
        installedBytes: null,
        installedByteErrors: null,
      };
      packages.set(packageInfo.root, packageRecord);
    }
    packageRecord.loadedFiles.add(file.path);
    packageRecord.loadInstances += file.instances;
    if (measuredBytes === null) packageRecord.unknownByteFiles += 1;
    else packageRecord.loadedFileBytes += measuredBytes;
  }

  const seenEdgeKeys = new Set();
  for (const edge of resolutionEdges) {
    const resolvedPath = physicalFilePath(edge.resolvedURL);
    if (resolvedPath === null) continue;
    const packageInfo = findPackageRoot(resolvedPath).packageInfo;
    const packageRecord = packageInfo === null ? undefined : packages.get(packageInfo.root);
    if (packageRecord === undefined || packageRecord.reachEvidence.length >= 8) continue;
    const key = JSON.stringify([edge.kind, edge.specifier, edge.parentURL, edge.resolvedURL]);
    if (seenEdgeKeys.has(key)) continue;
    seenEdgeKeys.add(key);
    packageRecord.reachEvidence.push(edge);
  }

  let installedByteErrors = 0;
  let reachedDependencyInstalledBytes = 0;
  let reachedDependencyInstalledByteErrors = 0;
  let reachedDependencyCount = 0;
  let reachedDirectDependencyInstalledBytes = 0;
  let reachedDirectDependencyInstalledByteErrors = 0;
  const reachedDirectDependencyNames = [];
  const packageRows = [...packages.values()].map((record) => {
    const measurement = packageContentMeasurement(record.root);
    record.installedBytes = measurement.bytes;
    record.installedByteErrors = measurement.errors;
    installedByteErrors += measurement.errors;
    if (record.dependency) {
      reachedDependencyCount += 1;
      reachedDependencyInstalledBytes += record.installedBytes;
      reachedDependencyInstalledByteErrors += record.installedByteErrors;
    }
    if (record.directDependency) {
      reachedDirectDependencyNames.push(record.topLevelName);
      reachedDirectDependencyInstalledBytes += record.installedBytes;
      reachedDirectDependencyInstalledByteErrors += record.installedByteErrors;
    }
    return {
      name: record.name,
      version: record.version,
      rootURL: record.rootURL,
      dependency: record.dependency,
      topLevelName: record.topLevelName,
      directDependency: record.directDependency,
      loadedFiles: record.loadedFiles.size,
      loadInstances: record.loadInstances,
      loadedFileBytes: record.loadedFileBytes,
      unknownByteFiles: record.unknownByteFiles,
      reachEvidence: record.reachEvidence,
      installedBytes: record.installedBytes,
      installedByteErrors: record.installedByteErrors,
      installedBytesComplete: record.installedByteErrors === 0,
    };
  }).sort((left, right) => (
    right.installedBytes - left.installedBytes
    || left.name.localeCompare(right.name)
    || left.rootURL.localeCompare(right.rootURL)
  ));

  const loadedFileRows = [...loadedFiles.values()].map((record) => ({
    url: record.url,
    instances: record.instances,
    formats: [...record.formats].sort(),
    observedBy: [...record.observedBy].sort(),
    bytes: record.measuredBytes,
    byteSource: record.byteSource,
  })).sort((left, right) => left.url.localeCompare(right.url));

  const requiredProcessEntryURLs = requiredEntryPaths.map((path) => pathToFileURL(path).href);
  const observedProcessEntryURLs = [...processEntryPaths]
    .sort()
    .map((path) => pathToFileURL(path).href);
  const missingRequiredEntryURLs = requiredEntryPaths
    .filter((path) => !processEntryPaths.has(path))
    .map((path) => pathToFileURL(path).href);
  const traceRecordsComplete = startRecords > 0
    && parsed.files.length === startRecords
    && startRecords === exitRecords
    && droppedRecords === 0
    && parsed.malformedLines === 0
    && parsed.recordValidationErrors === 0;
  const loadedBytesComplete = unknownByteFiles === 0;
  const installedBytesComplete = installedByteErrors === 0;
  const packageResolutionErrors = packageResolutionErrorRoots.size;
  const packageResolutionComplete = packageResolutionErrors === 0;
  const requiredEntriesObserved = missingRequiredEntryURLs.length === 0;

  return {
    v: 1,
    traceDirectory,
    traceFiles: parsed.files.map((file) => pathToFileURL(file).href),
    records: parsed.events.length,
    malformedLines: parsed.malformedLines,
    completeness: {
      startRecords,
      exitRecords,
      droppedRecords,
      recordValidationErrors: parsed.recordValidationErrors,
      installedByteErrors,
      packageResolutionErrors,
      traceRecordsComplete,
      loadedBytesComplete,
      installedBytesComplete,
      packageResolutionComplete,
      requiredEntriesObserved,
      complete: traceRecordsComplete
        && loadedBytesComplete
        && installedBytesComplete
        && packageResolutionComplete
        && requiredEntriesObserved,
    },
    processEntries: {
      required: requiredProcessEntryURLs,
      observed: observedProcessEntryURLs,
      missing: missingRequiredEntryURLs,
    },
    packageResolution: {
      errors: packageResolutionErrors,
      complete: packageResolutionComplete,
      roots: [...packageResolutionErrorRoots]
        .sort()
        .map((root) => pathToFileURL(root).href),
    },
    edges: {
      esmResolve: esmResolveEdges,
      cjsResolve: cjsResolveEdges,
      cjsResolveErrors,
    },
    loads: {
      moduleLoadEvents,
      cjsLoadEvents,
      successfulCjsLoads,
    },
    loaded: {
      uniqueFiles: loadedFiles.size,
      loadInstances: loadedFileRows.reduce((total, row) => total + row.instances, 0),
      observedSourceBytes,
      statFallbackBytes,
      measuredBytes: observedSourceBytes + statFallbackBytes,
      unknownByteFiles,
    },
    reachedDependencies: {
      count: reachedDependencyCount,
      installedBytes: reachedDependencyInstalledBytes,
      installedByteErrors: reachedDependencyInstalledByteErrors,
      installedBytesComplete: reachedDependencyInstalledByteErrors === 0,
      dependencyRootURL: dependencyRoot === null ? null : pathToFileURL(dependencyRoot).href,
    },
    reachedDirectDependencies: {
      count: reachedDirectDependencyNames.length,
      names: reachedDirectDependencyNames.sort(),
      installedBytes: reachedDirectDependencyInstalledBytes,
      installedByteErrors: reachedDirectDependencyInstalledByteErrors,
      installedBytesComplete: reachedDirectDependencyInstalledByteErrors === 0,
      projectRootURL: projectRoot === null ? null : pathToFileURL(projectRoot).href,
    },
    packages: packageRows,
    loadedFiles: loadedFileRows,
  };
}

export function writeTraceSummary(traceDirectory, options = {}) {
  const summary = summarizeTraceDirectory(traceDirectory, options);
  const summaryPath = join(traceDirectory, 'summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  return { summary, summaryPath };
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const traceDirectory = process.argv[2];
  if (!traceDirectory) {
    process.stderr.write('Usage: node summarize.mjs <absolute-trace-directory> [dependency-root]\n');
    process.exitCode = 2;
  } else {
    try {
      const { summary, summaryPath } = writeTraceSummary(traceDirectory, {
        ...(process.argv[3] === undefined ? {} : { dependencyRoot: process.argv[3] }),
      });
      process.stdout.write(`${JSON.stringify({ summaryPath, ...summary })}\n`);
    } catch (error) {
      process.stderr.write(`trace summary: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
