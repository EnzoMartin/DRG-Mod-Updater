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

const cliArg = process.argv.find((val) => {
  return val.startsWith('dir=');
});

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

async function fetchRegistry(startBar){
  startBar.increment(1);
  const registry = await got(modRegistry).json();
  startBar.increment(1);
  return registry;
}

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
      mods.versions[name] = version.trim()
    }
    return mods;
  },{names: [], versions: {} });

  startBar.increment(1);
  return installedMods;
}

function findMatchingMods(remoteRegistryArray, installedMods){
  return remoteRegistryArray.filter((item) => {
    return installedMods.names.indexOf(item.DisplayName) !== -1;
  });
}

function checkOutdatedMods(matchingMods, installedMods){
  return matchingMods.filter((item) => {
    return installedMods.versions[item.DisplayName] !== item.Version;
  },[]);
}

async function downloadFile(item, fileDownloadBars, totalDownloadsBar, progressBar){
  const url = item.DownloadUrl;
  const fileName = `${item.DisplayName} - V${item.Version} _P.pak`;

  const {headers} = await got.head(url);
  const contentLength = headers['content-length'];
  //const progressBar = fileDownloadBars.create(contentLength, 0);
  progressBar.update(null, {total: contentLength})

  const downloadStream = got.stream(url);
  const fileWriterStream = createWriteStream(path.join(modPath,fileName));

  downloadStream.on('downloadProgress', (stats) => {
    progressBar.update(stats.transferred, {filename: fileName});
  });

  return new Promise((resolve, reject) => {
    pipeline(downloadStream, fileWriterStream)
      .then(() => {
        totalDownloadsBar.increment(1);
        resolve();
      })
      .catch((err) => {
        console.error(`Download failed for ${fileName}`, err);
        reject(err);
      });
  });
}

function downloadOutdatedMods(outdatedMods, startBar){
  const totalDownloadsBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  totalDownloadsBar.start(outdatedMods.length, 0);

  const fileDownloadBars = new cliProgress.MultiBar({}, cliProgress.Presets.shades_classic);

  const promises = [];
  outdatedMods.forEach((item) => {
    const progressBar = fileDownloadBars.create(1, 0);
    promises.push(downloadFile(item, fileDownloadBars, totalDownloadsBar, progressBar));
  });

  Promise.all(promises).then(() => {
    totalDownloadsBar.stop();
    finished(startBar);
  }).catch((err) => {
    totalDownloadsBar.stop();
    console.error('Failed to download files', err);
    finished(startBar);
  })
}

function finished(startBar){
  startBar.increment(1);
  startBar.stop();
  console.log('Finished updating Mods');
}

// Begin
async function checkMods() {
  const startBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  startBar.start(5, 0);


  await Promise.all([
    fetchRegistry(startBar),
    getInstalledMods(startBar),
  ]).then((res) => {
    const remoteRegistry = res[0];
    const installedMods = res[1];

    const remoteRegistryArray = []
    for (const slug in remoteRegistry) {
      const item = remoteRegistry[slug];

      remoteRegistryArray.push({
        slug,
        ...item
      });
    }

    remoteRegistryArray.sort((a, b) => {
      return a.DisplayName.localeCompare(b.DisplayName);
    })

    const matchingMods = findMatchingMods(remoteRegistryArray, installedMods);

    const outdatedMods = checkOutdatedMods(matchingMods, installedMods);

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

checkMods();
