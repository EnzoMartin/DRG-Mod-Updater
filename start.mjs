import {createWriteStream, existsSync} from 'fs';
import { readdir } from 'fs/promises';
import {promisify} from 'util';
import cliProgress from 'cli-progress';
import stream from 'stream';
import path from 'path';
import got from 'got';

const pipeline = promisify(stream.pipeline);

const modRegistry = 'https://raw.githubusercontent.com/ArcticEcho/DRG-Mods/main/Mod%20Index.json';
const pakPath = 'FSD\\Content\\Paks';
let modPath;

// Grab the dir from command line
const cliArg = process.argv.find((val) => {
  return val.startsWith('dir=');
});

// Verify the path provided exists, append the Pak dir if not provided
if(cliArg){
  try {
    const pathArg = cliArg.replace('dir=', '');
    const gameDirPath = path.resolve(pathArg);
    if(existsSync(pathArg)){
      modPath = gameDirPath.includes('Paks') ? gameDirPath : path.join(gameDirPath, pakPath);
    }
  } catch(err) {
    throw new Error('Please provide a valid installation directory path for Deep Rock Galactic');
  }
} else {
  throw new Error('Please provide the installation directory path for Deep Rock Galactic');
}

/**
 * Fetches the JSON file that represents the Mod registry from the GitHub repo
 * @param {Object} startBar
 * @return {Promise<unknown>}
 */
async function fetchRegistry(startBar){
  startBar.increment(1);
  const registry = await got(modRegistry).json();
  startBar.increment(1);
  return registry;
}

/**
 * Parse and read the community Mod Pak files in the specified directory
 * @param {Object} startBar
 * @return {Promise<{names: *[], versions: {}}>}
 */
async function getInstalledMods(startBar){
  startBar.increment(1);
  const files = await readdir(modPath, { encoding: 'utf8' });
  files.sort();

  const installedMods = files.reduce((mods, item) => {
    const itemSplit = item.split(' - ');

    // Ignore pak files that aren't User Mods
    if(itemSplit.length > 1){
      const name = itemSplit[0];
      const version = itemSplit[1].replace('_P.pak','').split('V')[1] || '1';

      mods.names.push(name.trim());
      // Save the version separately to compare with registry later
      mods.versions[name] = version.trim()
    }
    return mods;
  },{names: [], versions: {} });

  startBar.increment(1);
  return installedMods;
}

/**
 * Filter the Mod registry with the locally installed Mod names
 * @param {Array} remoteRegistryArray
 * @param {Array} installedMods
 * @return {Array}
 */
function findMatchingMods(remoteRegistryArray, installedMods){
  return remoteRegistryArray.filter((item) => {
    return installedMods.names.indexOf(item.DisplayName) !== -1;
  });
}

/**
 * Compare the installed version of Mods to the version available in the Mod registry
 * @param {Array} matchingMods
 * @param {Object} installedMods
 * @return {Array}
 */
function checkOutdatedMods(matchingMods, installedMods){
  return matchingMods.filter((item) => {
    return installedMods.versions[item.DisplayName] !== item.Version;
  },[]);
}

/**
 * Download and save the updated mod files to the provided DRG Pak directory, also updates the progress bars
 * @param {Object} item
 * @param {Object} fileDownloadBars
 * @param {Object} totalDownloadsBar
 * @return {Promise<unknown>}
 */
async function downloadFile(item, fileDownloadBars, totalDownloadsBar){
  const url = item.DownloadUrl;
  const fileName = `${item.DisplayName} - V${item.Version} _P.pak`; // Format: Name - V0 _P.pak

  // Check the total size of the file to provide accurate progress
  const {headers} = await got.head(url);
  const contentLength = headers['content-length'];
  const progressBar = fileDownloadBars.create(contentLength, 0);
  progressBar.update(null, {total: contentLength})

  const downloadStream = got.stream(url);
  const fileWriterStream = createWriteStream(path.join(modPath,fileName));

  // Bind the progress events to the progress bar
  downloadStream.on('downloadProgress', (stats) => {
    progressBar.update(stats.transferred, {filename: fileName});
  });

  return new Promise((resolve, reject) => {
    pipeline(downloadStream, fileWriterStream)
      .then(() => {
        // File downloaded
        progressBar.setTotal(contentLength);
        progressBar.stop();
        totalDownloadsBar.increment(1);
        resolve();
      })
      .catch((err) => {
        // File failed
        progressBar.stop();
        console.error(`Download failed for ${fileName}`, err);
        reject(err);
      });
  });
}

/**
 * Loop through the outdated mods that need to be downloaded and trigger the download process
 * @param {Array} outdatedMods
 * @param {Object} startBar
 * @return {Promise<unknown[]>}
 */
function downloadOutdatedMods(outdatedMods, startBar){
  // Single bar for total downloads that need to be done
  const totalDownloadsBar = new cliProgress.SingleBar({
    format: '{bar} {percentage}% | Mods updated: {value}/{total}'
  }, cliProgress.Presets.shades_grey);
  totalDownloadsBar.start(outdatedMods.length, 0);

  // Multi-bar for each individual file downloads
  const fileDownloadBars = new cliProgress.MultiBar({
    format: '{bar} {percentage}% | ETA: {eta}s | {value}/{total} | Mod: {filename}'
  }, cliProgress.Presets.shades_classic);

  const promises = [];
  outdatedMods.forEach((item) => {
    promises.push(downloadFile(item, fileDownloadBars, totalDownloadsBar));
  });

  return Promise.all(promises).then(() => {
    setTimeout(() => {
      totalDownloadsBar.stop();
      finished(startBar);
    }, 1000); // TODO: Fix the odd race condition with text display, doesn't impact the download itself
  }).catch((err) => {
    totalDownloadsBar.stop();
    console.error('Failed to download files', err);
    finished(startBar);
  })
}

/**
 * All mods have been updated, close down the process
 * @param {Object} startBar
 */
function finished(startBar){
  startBar.increment(1);
  startBar.stop();
  setTimeout(() => {
    console.log('Finished updating Mods');
    process.exit(0);
  }, 2500);
}

/**
 * Main function holding the logic flow
 * @return {Promise<void>}
 */
async function checkMods() {
  // Main process bar for all steps needed to be performed
  const startBar = new cliProgress.SingleBar({
    format: '{bar} {percentage}% | Main Process - Step {value}/{total}'
  }, cliProgress.Presets.shades_classic);
  startBar.start(5, 0);

  await Promise.all([
    fetchRegistry(startBar),
    getInstalledMods(startBar),
  ]).then((res) => {
    const remoteRegistry = res[0];
    const installedMods = res[1];

    // Re-create registry as an array of objects
    const remoteRegistryArray = []
    for (const slug in remoteRegistry) {
      const item = remoteRegistry[slug];

      remoteRegistryArray.push({
        slug,
        ...item
      });
    }

    // All items (registry, local files) are sorted alphabetically by their Display Name
    remoteRegistryArray.sort((a, b) => {
      return a.DisplayName.localeCompare(b.DisplayName);
    })

    const matchingMods = findMatchingMods(remoteRegistryArray, installedMods);

    const outdatedMods = checkOutdatedMods(matchingMods, installedMods);

    // Download updated mods if any are found
    if (outdatedMods.length) {
      downloadOutdatedMods(outdatedMods, startBar);
    } else {
      finished(startBar);
    }
  }).catch(err => {
    startBar.stop();
    console.error('Failed to get data', err);
  });
}

// Begins the process
checkMods();
