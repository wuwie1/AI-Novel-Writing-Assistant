const { existsSync } = require("node:fs");
const path = require("node:path");

function missingDirectDependencies(packageDir, manifest) {
  const required = { ...manifest.dependencies, ...manifest.devDependencies };
  return Object.keys(required).filter((name) =>
    !existsSync(path.join(packageDir, "node_modules", name, "package.json")),
  );
}

module.exports = { missingDirectDependencies };
