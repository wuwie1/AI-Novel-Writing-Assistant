const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const server = path.resolve(__dirname, '../../..');
const fromServer = createRequire(path.join(server, 'package.json'));
function native(file, imports) {
  const filename = path.join(server, 'src', file);
  const compiled = fromServer('typescript').transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: fromServer('typescript').ModuleKind.CommonJS, target: fromServer('typescript').ScriptTarget.ES2022 }, fileName: filename,
  }).outputText;
  const exports = {};
  vm.runInThisContext(`(function(require,exports){${compiled}\n})`, { filename })(id => {
    if (!Object.hasOwn(imports, id)) throw new Error(`Unexpected production import: ${id}`);
    return imports[id];
  }, exports);
  return exports;
}
function timeline() {
  const repo = native('modules/timeline/timeline.repository.ts', { '../../db/prisma': { prisma: {} }, '../novel/persistence': fromServer('./dist/modules/novel/persistence') });
  const services = native('modules/timeline/timeline.service.ts', { './timeline.repository': repo });
  return tx => { const repository = new repo.PrismaTimelineRepository(tx); return { repository, service: new services.StoryTimelineService(repository) }; };
}
function resources() {
  const boundary = native('services/novel/state/context/ChapterStateBoundary.ts', {
    'node:crypto': require('node:crypto'), '../../../../db/prisma': {prisma:{}},
    '../../runtime/artifactSync/ChapterArtifactSyncBoundary': fromServer('./dist/services/novel/runtime/artifactSync/ChapterArtifactSyncBoundary'),
    '../../runtime/artifactSync/ChapterArtifactContentVersion': fromServer('./dist/services/novel/runtime/artifactSync/ChapterArtifactContentVersion'),
  });
  const shared = fromServer('./dist/services/novel/characterResource/characterResourceShared');
  const ledger = native('services/novel/characterResource/CharacterResourceLedgerService.ts', {
    '../../../db/prisma': { prisma: {} }, '../runtime/artifactSync/contracts': {}, './characterResourceShared': shared, '../state/context/ChapterStateBoundary': boundary,
  });
  const canonical = native('services/novel/state/CanonicalStateService.ts', { '../../../db/prisma': { prisma: {} }, '../characterResource/CharacterResourceLedgerService': ledger, './context/ChapterStateBoundary': boundary });
  const versions = native('services/novel/state/StateVersionLog.ts', { '../../../db/prisma': { prisma: {} } });
  return { canonical: new canonical.CanonicalStateService(), versions: new versions.StateVersionLog() };
}
module.exports = { timeline, resources };
