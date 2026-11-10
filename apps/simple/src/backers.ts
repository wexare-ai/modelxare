// weXare's investors, shown at the foot of the front page. To add one, put the
// logo it publishes in ./backers/ (unchanged, preferably SVG) and add an entry.
import mozillaVentures from './backers/mozilla-ventures.svg';

export interface Backer {
  name: string;
  href: string;
  logo: string;
}

export const BACKERS: readonly Backer[] = [{ name: 'Mozilla Ventures', href: 'https://mozilla.vc/', logo: mozillaVentures }];
