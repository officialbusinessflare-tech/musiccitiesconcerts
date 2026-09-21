// src/lib/albums.ts
//
// Recently-added photo albums. This powers the red "NEW" badge on the Photos
// pill in the nav and the "What's New" row at the top of /photos.
//
// HOW TO USE: whenever you post a new Pinterest album, add one line to
// NEW_ALBUMS below with today's date. That's it. Entries automatically stop
// counting as new after NEW_WINDOW_DAYS, so the badge and the row clear
// themselves. You never have to come back and remove anything.
//
// The album also lives in the permanent list on src/pages/photos.astro. This
// list is only the temporary "just posted" highlight.

export interface NewAlbum {
  title: string; // album name
  event: string; // which event/section it belongs to
  url: string;   // full Pinterest board URL
  added: string; // date you posted it, YYYY-MM-DD
}

// How many days an album stays flagged as new.
export const NEW_WINDOW_DAYS = 14;

export const NEW_ALBUMS: NewAlbum[] = [
  {
    title: 'Butterbrain, Fuakata and more at Kill Your Idol',
    event: 'Kill Your Idol, Miami Beach',
    url: 'https://www.pinterest.com/TheMusicCitiesPodcast/kill-your-idol-82826-butterbrain-fukuata-more/',
    added: '2026-09-21',
  },
];

export function freshAlbums(now: Date = new Date()): NewAlbum[] {
  const cutoff = now.getTime() - NEW_WINDOW_DAYS * 86400000;
  return NEW_ALBUMS.filter((a) => {
    const t = Date.parse(a.added + 'T00:00:00');
    return !Number.isNaN(t) && t >= cutoff;
  });
}

export function hasFreshAlbums(now: Date = new Date()): boolean {
  return freshAlbums(now).length > 0;
}
