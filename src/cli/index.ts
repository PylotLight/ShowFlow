import { Command } from 'commander';
import { DownloadManager } from '../backend/core/download_manager';
import { LibraryScanner } from '../backend/core/library_scanner';
import { Oracle } from '../backend/parser/oracle';
import { ProviderFactory, type ProviderType } from '../backend/providers/factory';
import { ConfigSchema, db } from '../backend/db';
import { DEBUG } from '../backend/core/debug';
import { CalendarManager } from '../backend/core/calendar_manager';
import fs from 'node:fs';
import path from 'node:path';

const program = new Command();

program
  .name('showflow')
  .description('Metadata-first automation engine for media libraries');

function loadConfig() {
  const settings = db.getAllSettings();
  const configObj: any = {};
  for (const s of settings) {
    try {
      configObj[s.key] = JSON.parse(s.value);
    } catch {
      configObj[s.key] = s.value;
    }
  }

  if (Object.keys(configObj).length === 0) {
    const configPath = path.join(process.cwd(), 'config.json');
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      for (const [k, v] of Object.entries(raw)) {
        db.setSetting(k, v);
      }
      return loadConfig();
    }
    console.error('No configuration found. Run `showflow init` first.');
    process.exit(1);
  }
  return ConfigSchema.parse(configObj);
}

program
  .command('scan')
  .description('Scan the library directory to map existing files')
  .action(async () => {
    const config = loadConfig();
    const scanner = new LibraryScanner(config);
    await scanner.scan();
  });

program
  .command('watch')
  .description('Start the watch folder orchestration')
  .action(async () => {
    const config = loadConfig();
    const manager = new DownloadManager(config);
    await manager.start();
    console.log('ShowFlow is now watching. Press Ctrl+C to stop.');
  });

program
  .command('init')
  .description('Initialize a default config.json')
  .action(() => {
    const defaultConfig = {
      apiKeys: {},
      defaultProvider: 'tmdb',
      onCollision: 'skip',
      dryRun: false,
    };
    fs.writeFileSync('config.json', JSON.stringify(defaultConfig, null, 2));
    console.log('Created default config.json. Configure library path and root folders via the UI.');
  });

const showCmd = program.command('show').description('Manage registered shows');

showCmd
  .command('add')
  .description('Register a show with a specific metadata provider')
  .argument('[name]', 'Show name (optional)')
  .requiredOption('--source <source>', 'Metadata source: tmdb|tvdb|anilist')
  .requiredOption('--id <id>', 'Provider-specific show ID')
  .option('--episode-group <group>', 'Provider episode group ID')
  .action(async (name: string | undefined, opts: { source: string; id: string; episodeGroup?: string }) => {
    const providerType = opts.source as ProviderType;
    if (!['tmdb', 'tvdb', 'anilist'].includes(providerType)) {
      console.error(`Unknown source "${opts.source}". Must be one of: tmdb, tvdb, anilist.`);
      process.exit(1);
    }
    try {
      const config = loadConfig();
      const provider = ProviderFactory.getProvider(providerType, config);
      let finalName = name;
      if (!finalName) {
        const show = await provider.getShow(opts.id);
        finalName = show.title;
      }
      const existingShow = db.getShow(opts.id);
      db.saveShow({
        uuid: existingShow?.uuid ?? crypto.randomUUID(),
        providerId: opts.id,
        type: providerType,
        title: finalName,
        config: { name: finalName, episodeGroup: opts.episodeGroup },
      });
      
      // Automatic sync after adding a show
      try {
        const episodes = await provider.getEpisodes(opts.id);
        db.syncEpisodes(opts.id, episodes.map(e => ({
          seasonNumber: e.season,
          episodeNumber: e.episode,
          absoluteNumber: e.absoluteNumber,
          title: e.title
        })));
        console.log(`Automatically synced ${episodes.length} episodes for "${finalName}".`);
      } catch (syncErr: any) {
        console.warn(`Warning: Initial sync failed for "${finalName}": ${syncErr.message}`);
      }
      console.log(`${existingShow ? 'Updated' : 'Added'} "${finalName}" using ${providerType} (ID: ${opts.id})`);
    } catch (err: any) {
      console.error(`Failed to add show: ${err.message}`);
      process.exit(1);
    }
  });

showCmd
  .command('list')
  .description('List all registered shows')
  .action(() => {
    const shows = db.listShows();
    if (shows.length === 0) {
      console.log('No shows registered.');
      return;
    }
    console.table(shows.map(s => ({ title: s.title, id: s.provider_id, provider: s.provider_type })));
  });

showCmd
  .command('search')
  .description('Search for a show')
  .argument('<query>', 'Show title')
  .option('--source <source>', 'Metadata source', 'tvdb')
  .action(async (query: string, opts: { source?: string }) => {
    const config = loadConfig();
    const source = (opts.source as ProviderType) || config.defaultProvider;
    const provider = ProviderFactory.getProvider(source, config);
    const results = await provider.searchShow(query);
    if (results.length === 0) {
      console.log(`No results found for "${query}" on ${source}.`);
      return;
    }
    console.table(results.map(r => ({ id: r.id, title: r.title, year: r.year })));
  });

showCmd
  .command('remove')
  .description('Remove a registered show')
  .argument('<id>', 'Provider-specific show ID')
  .action((id) => {
    db.removeShow(id);
    console.log(`Removed show with ID: ${id}`);
  });

showCmd
  .command('info')
  .description('Detailed info for a show')
  .argument('<id>', 'Provider-specific show ID')
  .action(async (id) => {
    const show = db.getShow(id);
    if (!show) {
      console.error(`Show with ID ${id} not found.`);
      process.exit(1);
    }
    const config = loadConfig();
    const provider = ProviderFactory.getProvider(show.provider_type, config);
    try {
      const metadata = await provider.getShow(id);
      const episodes = db.listAllEpisodes(id);
      console.log(`\nShow: ${metadata.title} (${metadata.year || 'N/A'})`);
      console.log(`ID:   ${id} [${show.provider_type}]`);
      console.log(`Tracked Episodes: ${episodes.length}`);
    } catch (e: any) {
      console.error(`Failed to fetch metadata: ${e.message}`);
    }
  });

showCmd
  .command('sync')
  .description('Sync all episode metadata from provider to local database')
  .argument('<id>', 'Show ID')
  .action(async (id) => {
    const show = db.getShow(id);
    if (!show) {
      console.error(`Show with ID ${id} not found.`);
      process.exit(1);
    }
    const config = loadConfig();
    const provider = ProviderFactory.getProvider(show.provider_type, config);
    const episodes = await provider.getEpisodes(id);
    db.syncEpisodes(id, episodes.map(e => ({
      seasonNumber: e.season,
      episodeNumber: e.episode,
      absoluteNumber: e.absoluteNumber,
      title: e.title
    })));
    console.log(`Synced ${episodes.length} episodes for show ${id}.`);
  });

const epCmd = program.command('ep').description('Manage episodes');

epCmd
  .command('list')
  .description('List episodes for a show')
  .argument('<id>', 'Show ID')
  .argument('[season]', 'Season number (optional)')
  .action((id, seasonStr) => {
    const season = seasonStr ? parseInt(seasonStr) : null;
    const episodes = season ? db.listEpisodes(id, season) : db.listAllEpisodes(id);
    if (episodes.length === 0) {
      console.log('No episodes found in database.');
      return;
    }
    console.table(episodes.map(e => ({
      season: e.season_number,
      episode: e.episode_number,
      title: e.title,
      tracked: e.is_tracked ? '✅' : '❌',
      path: e.file_path || 'N/A'
    })));
  });

epCmd
  .command('mark')
  .description('Mark an episode as tracked/untracked')
  .argument('<id>', 'Show ID')
  .argument('<season>', 'Season number')
  .argument('<episode>', 'Episode number')
  .argument('<status>', 'tracked|untracked')
  .action((id, season, episode, status) => {
    const tracked = status.toLowerCase() === 'tracked';
    db.setTracked(id, parseInt(season), parseInt(episode), tracked);
    console.log(`Marked S${season}E${episode} as ${status}.`);
  });

epCmd
  .command('mark-season')
  .description('Mark a whole season as tracked/untracked')
  .argument('<id>', 'Show ID')
  .argument('<season>', 'Season number')
  .argument('<status>', 'tracked|untracked')
  .action((id, season, status) => {
    const tracked = status.toLowerCase() === 'tracked';
    const episodes = db.listEpisodes(id, parseInt(season));
    episodes.forEach(e => db.setTracked(id, e.season_number, e.episode_number, tracked));
    console.log(`Marked Season ${season} as ${status}.`);
  });

program
  .command('test-parse')
  .description('Dry-run a filename through the parser')
  .argument('<filename>', 'Filename to test')
  .option('--source <source>', 'Metadata source', 'tmdb')
  .action(async (filename: string, opts: { source: string }) => {
    const oracle = new Oracle();
    try {
      const config = loadConfig();
      const result = await oracle.resolve(filename, opts.source as ProviderType, config);
      if (!result) {
        console.log('Could not resolve metadata.');
        return;
      }
      const { show, episodes, proposedPath } = result;
      const episode = episodes[0];
      console.log(`Show:      ${show.title} (${show.provider}#${show.id})`);
      console.log(`Episode:   S${String(episode?.season).padStart(2, '0')}E${String(episode?.episode).padStart(2, '0')}`);
      console.log(`Proposed:  ${proposedPath}`);
    } catch (err: any) {
      console.error(`Failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('calendar')
  .description('Upcoming episodes')
  .option('--days <number>', 'Days look ahead', '7')
  .action(async (opts: { days: string }) => {
    const config = loadConfig();
    const calendar = new CalendarManager(config);
    const days = parseInt(opts.days);
    const upcoming = await calendar.getUpcomingEpisodes(days);
    console.table(upcoming.map(ep => ({ date: ep.airDate.toISOString().split('T')[0], show: ep.showTitle, episode: `S${ep.season}E${ep.episode}`, title: ep.episodeTitle })));
  });

program.parse();
