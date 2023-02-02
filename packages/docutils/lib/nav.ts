import {fs} from '@appium/support';
import _ from 'lodash';
import path from 'node:path';
import {DEFAULT_REL_TYPEDOC_OUT_PATH} from './constants';
import {
  guessMkDocsYmlPath,
  guessTypeDocJsonPath,
  readTypedocJson,
  readYaml,
  safeWriteFile,
  stringifyYaml,
} from './fs';
import logger from './logger';
import {MkDocsYml} from './model';
import {relative} from './util';

const DEFAULT_REFERENCE_HEADER = 'Reference';

const log = logger.withTag('mkdocs-nav');

/**
 *
 * @param opts - Options
 * @todo implement `dryRun` option
 */
export async function updateNav<S extends string>({
  cwd = process.cwd(),
  mkdocsYml: mkDocsYmlPath,
  packageJson: packageJsonPath,
  referenceHeader = <S>DEFAULT_REFERENCE_HEADER,
  noReferenceHeader = false,
  typedocJson: typeDocJsonPath,
  dryRun = false,
}: UpdateNavOpts<S> = {}) {
  [mkDocsYmlPath, typeDocJsonPath] = await Promise.all([
    mkDocsYmlPath ?? guessMkDocsYmlPath(cwd, packageJsonPath),
    typeDocJsonPath ?? guessTypeDocJsonPath(cwd, packageJsonPath),
  ]);
  const relativePath = relative(cwd);
  const relMkDocsYmlPath = relativePath(mkDocsYmlPath);
  const typeDocJson = readTypedocJson(typeDocJsonPath);
  const mkDocsYml = (await readYaml(mkDocsYmlPath)) as MkDocsYml;
  const findRefDictIndex: (nav: MkDocsYml['nav']) => number = _.partial(
    _.findIndex,
    _,
    _.overEvery([_.isObject, _.partial(_.has, _, referenceHeader)])
  );

  /**
   * Absolute path to `typedoc.json`
   */
  const absTypeDocJsonPath = path.isAbsolute(typeDocJsonPath)
    ? typeDocJsonPath
    : path.resolve(cwd, typeDocJsonPath);

  /**
   * Absolute path to TypeDoc's output directory (`out`)
   */
  const typeDocOutDir = path.resolve(
    path.dirname(absTypeDocJsonPath),
    typeDocJson.out ? typeDocJson.out : DEFAULT_REL_TYPEDOC_OUT_PATH
  );

  /**
   * Absolute path to `mkdocs.yml`
   */
  const absMkdocsYmlPath = path.isAbsolute(mkDocsYmlPath)
    ? mkDocsYmlPath
    : path.resolve(cwd, mkDocsYmlPath);

  const {docs_dir: docsDir, nav = []} = mkDocsYml;
  /**
   * Absolute path to the directory containing MkDocs input docs
   */
  const mkDocsDocsDir = path.resolve(path.dirname(absMkdocsYmlPath), docsDir ?? 'docs');

  /**
   * The dir we need to prepend to all entries within `nav`
   */
  const relReferenceDir = path.relative(mkDocsDocsDir, typeDocOutDir);

  const partitionRefArray: <T, U extends T>(arr: T[]) => [U[], Array<Exclude<T, U>>] =
    _.partialRight(_.partition, _.partialRight(_.startsWith, `${relReferenceDir}/`));

  const newRefFilepaths: string[] = [];

  // TODO: this doesn't respect the 'commandsDir' option for typedoc-plugin-appium.  in fact,
  // typeDocJson does not even include it, because it's unknown.  I suppose that will mean we need
  // to load plugins, but that means bootstrapping TypeDoc entirely just to read a `typedoc.json`
  // file, which is slow.
  const commandDir = path.join(typeDocOutDir, 'commands');
  const relCommandDir = path.relative(mkDocsDocsDir, commandDir);
  const commandDocFileEnts = await fs.readdir(commandDir, {withFileTypes: true});
  if (!commandDocFileEnts.length) {
    log.warn('No reference API docs were found in %s; skipping navigation update', commandDir);
    return;
  }
  for (const ent of commandDocFileEnts) {
    if (ent.isFile() && ent.name.endsWith('.md')) {
      newRefFilepaths.push(path.join(relCommandDir, ent.name));
    }
  }

  log.debug('New reference filepaths: %O', newRefFilepaths);

  const navUsesHeaders = noReferenceHeader || !isStringArray(nav);
  let shouldWriteMkDocsYml = false;
  let refFilepaths: string[];
  let nonRefFilepaths: string[];

  const refDictIdx = findRefDictIndex(nav);
  if (refDictIdx >= 0) {
    const refDict = nav[refDictIdx] as Record<S, string[]>;
    const refArray = refDict[referenceHeader];
    [refFilepaths, nonRefFilepaths] = partitionRefArray(refArray);
  } else {
    [refFilepaths, nonRefFilepaths] = partitionRefArray(<string[]>nav);
  }

  const symmetricDiff = _.xor(newRefFilepaths, refFilepaths);
  if (symmetricDiff.length) {
    log.debug('Difference in old nav vs new: %O', symmetricDiff);
    shouldWriteMkDocsYml = true;
    if (navUsesHeaders) {
      if (refDictIdx >= 0) {
        const res = [...nonRefFilepaths, ...newRefFilepaths];
        (mkDocsYml.nav![refDictIdx] as Record<S, string[]>)[referenceHeader] = res;
        log.debug('Replaced "%s" section with %O', referenceHeader, res);
      } else {
        mkDocsYml.nav = [...nonRefFilepaths, {[referenceHeader]: newRefFilepaths}];
        log.debug('Added "%s" section with %O', referenceHeader, newRefFilepaths);
      }
    } else {
      mkDocsYml.nav = [...nonRefFilepaths, ...newRefFilepaths];
      log.debug('Replaced nav with %O', mkDocsYml.nav);
    }
  }

  if (shouldWriteMkDocsYml) {
    const yaml = stringifyYaml(mkDocsYml);
    log.debug(yaml);
    await safeWriteFile(mkDocsYmlPath, yaml, true);
    log.success('Updated navigation for reference documents in %s', relMkDocsYmlPath);
  } else {
    log.info('No changes to navigation for reference documents in %s', relMkDocsYmlPath);
  }
}

/**
 * Type guard to narrow an array to a string array
 * @param value any value
 * @returns `true` if the array is `string[]`
 */
const isStringArray = _.overEvery(_.isArray, _.partial(_.every, _, _.isString)) as (
  value: any
) => value is string[];

export interface UpdateNavOpts<S extends string> {
  cwd?: string;
  mkdocsYml?: string;
  packageJson?: string;
  referenceHeader?: S;
  /**
   * If `true`, do not add a reference header to `nav` if one does not exist
   */
  noReferenceHeader?: boolean;
  typedocJson?: string;
  dryRun?: boolean;
}