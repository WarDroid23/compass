const path = require('path');
const { promises: fs } = require('fs');
const semver = require('semver');
const chalk = require('chalk');
const { runInDir } = require('./run-in-dir');
const { updatePackageJson } = require('./monorepo/update-package-json');
const { withProgress } = require('./monorepo/with-progress');

const USAGE = `Check for dependency alignment issues.

USAGE: depalign.js [--skip-deduped] [--json] [--autofix] [--type peer,optional]

Options:

  --skip-deduped                     Don't output warnings and don't autofix ranges that can be resolved to a single version.
  --json                             Output a json report.
  --type                             Type (or types) of the dependencies to include in the report. Possible values are 'prod', 'dev', 'peer', and 'optional'. Defaults to prod, dev, and optional.
  --types-only                       Will only include a dependency in the report if all packages have this dependency as one of the provided with --type argument.
  --autofix                          Output a list of replacements to normalize ranges and align everything to the highest possible range.
  --autofix-only                     Will only autofix dependencies provided with this option
  --dangerously-include-mismatched   Include mismatched dependencies into autofix.
  --config                           Path to the config. Default is .depalignrc.json
  --validate-config                  Check that 'ignore' option in the config doesn't include extraneous dependencies and versions

.depalignrc.json

.depalignrc.json can list ignored dependency ranges that will be excluded from the check.

For example: {"ignore": {"async": ["^1.2.3"]}}.
`;

const ROOT_DIR = path.resolve(__dirname, '..');

const LERNA_BIN = path.join(ROOT_DIR, 'node_modules', '.bin', 'lerna');

async function main(args) {
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const depalignrcPath =
    typeof args.config == 'string'
      ? path.resolve(process.cwd(), args.config)
      : path.join(process.cwd(), '.depalignrc.json');

  let depalignrc;

  if (typeof args.config === 'boolean' && !args.config) {
    depalignrc = {};
  } else {
    try {
      depalignrc = JSON.parse(await fs.readFile(depalignrcPath, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT' && args.config) {
        console.error("Can't find config at path %s.", depalignrcPath);
        throw e;
      } else if (e.code !== 'ENOENT') {
        console.error('Unexpected error happened loading config file:');
        throw e;
      }
      // We didn't find the file and it's a default config path that we were
      // checking for, we can ignore that as config file is optional
    }
  }

  const outputJson = args.json;
  const shouldApplyFixes = args.autofix;
  const shouldCheckConfig = args['validate-config'];
  const fixOnly = new Set(args['autofix-only']);
  const includeTypes = args.type;
  const includeTypesOnly = args['types-only'];
  const includeDeduped = !args['skip-deduped'];
  const includeMismatched = args['dangerously-include-mismatched'];

  const workspaces = await collectWorkspacesMeta();
  const dependencies = collectWorkspacesDependencies(workspaces);
  const report = generateReport(dependencies, {
    includeTypes,
    includeTypesOnly,
    ...depalignrc,
    // We want a full report with ignore option "disabled" so that we can check
    // config against all existing mismatches
    ...(shouldCheckConfig && { ignore: {} })
  });

  if (shouldCheckConfig) {
    const { ignore, extraneous } = normalizeIgnore(report, depalignrc.ignore);

    if (shouldApplyFixes) {
      await fs.writeFile(
        depalignrcPath,
        JSON.stringify({ ...depalignrc, ignore }, null, 2),
        'utf8'
      );

      extraneous.clear();
    }

    if (extraneous.size > 0) {
      console.log(
        'Following extraneous versions found in the `ignore` config option in %s: %s',
        path.relative(process.cwd(), depalignrcPath),
        chalk.dim('(can be fixed with --autofix)')
      );
      console.log();

      for (const [depName, versions] of extraneous) {
        const versionPadStart = Math.max(
          ...versions.map((version) => version.length)
        );
        console.log(
          '  %s %s',
          chalk.bold(depName),
          versions.length === depalignrc.ignore[depName].length
            ? chalk.dim('(whole rule)')
            : ''
        );
        console.log();
        versions.forEach((version) => {
          console.log(
            '    %s%s',
            ' '.repeat(versionPadStart - version.length),
            version
          );
        });
        console.log();
      }
    } else {
      console.log(
        '%s',
        chalk.green('No extraneous rules found in depalign config')
      );
    }

    process.exitCode = extraneous.size;
    return;
  }

  if (!includeDeduped) {
    report.deduped = new Map();
  }

  if (shouldApplyFixes) {
    if (includeMismatched) {
      console.log();
      console.log(
        `%s: You are about to update mismatched dependencies which might potentially be a %s. Please make sure that everything is still working as expected after the update.`,
        chalk.yellow('Warning'),
        chalk.bold('breaking change')
      );
      console.log();
    }

    await withProgress(
      `Applying autofixes`,
      applyFixes,
      report,
      includeMismatched,
      fixOnly
    );

    console.log();
  }

  if (outputJson) {
    console.log(
      JSON.stringify(
        report,
        (_key, val) => {
          if (val instanceof Map) {
            return Object.fromEntries(val);
          } else if (val instanceof Set) {
            return Array.from(val);
          } else {
            return val;
          }
        },
        2
      )
    );
  } else {
    prettyPrintReport(report);
  }

  process.exitCode = report.mismatched.size;
}

async function collectWorkspacesMeta() {
  const workspaces = JSON.parse(
    (await runInDir(`${LERNA_BIN} list --all --json --toposort`)).stdout
  );

  return new Map(
    workspaces
      .concat({ location: ROOT_DIR })
      .map(({ location }) => [
        location,
        require(path.join(location, 'package.json'))
      ])
  );
}

const DepTypes = {
  Prod: 'prod',
  Dev: 'dev',
  Optional: 'optional',
  Peer: 'peer'
};

function getDepType(dependency, version, pkgJson) {
  return pkgJson.devDependencies &&
    pkgJson.devDependencies[dependency] === version
    ? DepTypes.Dev
    : pkgJson.peerDependencies &&
      pkgJson.peerDependencies[dependency] === version
    ? DepTypes.Peer
    : pkgJson.optionalDependencies &&
      pkgJson.optionalDependencies[dependency] === version
    ? DepTypes.Optional
    : pkgJson.dependencies && pkgJson.dependencies[dependency] === version
    ? DepTypes.Prod
    : null;
}

function collectWorkspacesDependencies(workspaces) {
  const dependencies = new Map();

  for (const [location, pkgJson] of workspaces) {
    for (const [dependency, versionRange] of [
      ...Object.entries(pkgJson.dependencies || {}),
      ...Object.entries(pkgJson.devDependencies || {}),
      ...filterOutStarDeps(Object.entries(pkgJson.peerDependencies || {})),
      ...filterOutStarDeps(Object.entries(pkgJson.optionalDependencies || {}))
    ]) {
      const item = {
        version: versionRange,
        from: location,
        type: getDepType(dependency, versionRange, pkgJson)
      };

      if (dependencies.has(dependency)) {
        dependencies.get(dependency).push(item);
      } else {
        dependencies.set(dependency, [item]);
      }
    }
  }

  return dependencies;
}

function filterOutStarDeps(entries) {
  return entries.filter(([, v]) => v !== '*');
}

function generateReport(
  dependencies,
  { includeTypes, includeTypesOnly, ignore = {} } = { ignore: {} }
) {
  const report = { mismatched: new Map(), deduped: new Map() };

  for (const [depName, versions] of dependencies) {
    const ignoredVersions = new Set(ignore[depName] || []);
    const notIgnoredVersions = versions.filter(
      ({ version }) => !ignoredVersions.has(version)
    );
    const notIgnoredUniqueVersionsOnly = Array.from(
      new Set(notIgnoredVersions.map(({ version }) => version))
    );

    if (notIgnoredUniqueVersionsOnly.length <= 1) {
      continue;
    }

    if (
      includeTypesOnly
        ? !notIgnoredVersions.every(({ type }) => includeTypes.includes(type))
        : !notIgnoredVersions.some(({ type }) => includeTypes.includes(type))
    ) {
      continue;
    }

    const reportItem = {
      versions: notIgnoredVersions,
      fixes: calculateReplacements(notIgnoredUniqueVersionsOnly)
    };

    if (!intersects(notIgnoredUniqueVersionsOnly)) {
      report.mismatched.set(depName, reportItem);
    } else {
      report.deduped.set(depName, reportItem);
    }
  }

  return report;
}

function intersects(range) {
  for (const [idx, v1] of Object.entries(range)) {
    for (const v2 of range.slice(Number(idx) + 1)) {
      try {
        if (!semver.intersects(v1, v2)) {
          return false;
        }
      } catch (e) {
        return false;
      }
    }
  }
  return true;
}

function calculateReplacements(ranges) {
  const replacements = new Map();
  const highestRange = getHighestRange(ranges);

  for (const range of ranges) {
    try {
      if (semver.subset(highestRange, range)) {
        replacements.set(range, highestRange);
      }
    } catch (e) {
      // Range is probably not valid, let's proceed as if there is no
      // replacement for it
    }
  }

  return replacements;
}

function getHighestRange(ranges) {
  const validRanges = ranges.filter(
    (range) => semver.validRange(range) && range !== '*'
  );

  const sortedRanges = validRanges.sort((v1, v2) => {
    const res = semver.compare(semver.minVersion(v2), semver.minVersion(v1));

    if (res === 1 || res === -1) {
      return res;
    }

    if (semver.valid(v1) && !semver.valid(v2)) {
      return 1;
    }

    if (!semver.valid(v1) && semver.valid(v2)) {
      return -1;
    }

    return 0;
  });

  return sortedRanges[0] || null;
}

function normalizeIgnore({ deduped, mismatched }, ignore = {}) {
  const ignoreMap = new Map(Object.entries(ignore));
  const mergedReport = new Map([...deduped, ...mismatched]);
  const extraneous = new Map();
  const newIgnore = { ...ignore };

  for (const [depName, versions] of ignoreMap) {
    if (mergedReport.has(depName)) {
      const reportItemVersionsOnly = new Set(
        mergedReport.get(depName).versions.map(({ version }) => version)
      );
      const extraneousVersions = versions.filter(
        (version) => !reportItemVersionsOnly.has(version)
      );
      if (extraneousVersions.length > 0) {
        extraneous.set(depName, extraneousVersions);
      }
      newIgnore[depName] = versions.filter((version) =>
        reportItemVersionsOnly.has(version)
      );
    } else {
      extraneous.set(depName, versions);
      delete newIgnore[depName];
    }
  }

  return { ignore: newIgnore, extraneous };
}

async function applyFixes(
  { deduped, mismatched },
  includeMismatched = false,
  fixOnly = new Set()
) {
  const spinner = this;
  const spinnerText = spinner.text;

  const fixAll = fixOnly.size === 0;

  const updates = new Map([
    ...deduped,
    ...(includeMismatched ? mismatched : [])
  ]);

  if (updates.size === 0) {
    return updates.size;
  }

  spinner.text = `${spinnerText} for ${updates.size} dependencies (collecting info)`;

  const updatesByPackage = new Map();

  for (const [depName, { versions, fixes }] of updates) {
    if (!fixAll && !fixOnly.has(depName)) {
      continue;
    }

    deduped.delete(depName);
    mismatched.delete(depName);

    for (const { version, from } of versions) {
      // Deduped versions will always have a fix, for mismatched we fall back to
      // highest version (you need to opt in into this potentially breaking
      // update so you should know what you're doing)
      const fixVersion = fixes.get(version) || fixes.values().next().value;

      if (updatesByPackage.has(from)) {
        updatesByPackage.get(from).set(depName, fixVersion);
      } else {
        updatesByPackage.set(from, new Map([[depName, fixVersion]]));
      }
    }
  }

  spinner.text = `${spinnerText} for ${updates.size} dependencies (updating package.json)`;

  for (const [location, updates] of updatesByPackage) {
    await updatePackageJson(location, (pkgJson) => {
      updates.forEach((version, name) => {
        for (const depType of [
          'dependencies',
          'devDependencies',
          'peerDependencies',
          'optionalDependencies'
        ]) {
          if ((pkgJson[depType] || {})[name]) {
            pkgJson[depType][name] = version;
          }
        }
      });
      return pkgJson;
    });
  }

  spinner.text = `${spinnerText} for ${updates.size} dependencies (updating package-lock.json)`;

  await runInDir('npm install --package-lock-only');

  spinner.text = `${spinnerText} for ${updates.size} dependencies`;

  return updates.size;
}

function prettyPrintReport({ deduped, mismatched }) {
  function printReportItems(items) {
    items.forEach(({ versions }, depName) => {
      const versionPadStart = Math.max(
        ...versions.map(({ version }) => version.length)
      );
      console.log('  %s', chalk.bold(depName));
      console.log();
      versions.forEach(({ version, from, type }) => {
        console.log(
          '    %s%s %s',
          ' '.repeat(versionPadStart - version.length),
          version,
          chalk.dim(
            `at ${path.relative(process.cwd(), from) || 'root'} ${
              // Not printing prod ones as it's kinda implied
              type !== DepTypes.Prod ? `(${type})` : ''
            }`.trim()
          )
        );
      });
      console.log();
    });
  }

  if (deduped.size > 0) {
    console.log(
      '%s %s',
      chalk.bold.yellow('Deduped:'),
      chalk.dim('(can be fixed with --autofix)')
    );
    console.log();
    printReportItems(deduped);
  }

  if (mismatched.size > 0) {
    console.log(chalk.bold.red('Mismatched:'));
    console.log();
    printReportItems(mismatched);
  }

  if (deduped.size === 0 && mismatched.size === 0) {
    console.log(
      '%s',
      chalk.green('All dependencies are aligned, nothing to report!')
    );
  }
}

process.on('unhandledRejection', (err) => {
  console.error();
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});

function parseOptions() {
  args = require('minimist')(process.argv.slice(2));

  if (typeof args.type === 'string') {
    args.type = args.type.split(',');
  }

  if (typeof args['autofix-only'] === 'string') {
    args['autofix-only'] = args['autofix-only'].split(',');
  }

  return {
    ['skip-deduped']: false,
    json: false,
    type: ['prod', 'dev', 'optional'],
    ['types-only']: false,
    autofix: false,
    ['autofix-only']: [],
    ['dangerously-include-mismatched']: false,
    ['validate-config']: false,
    ...args
  };
}

main(parseOptions());
