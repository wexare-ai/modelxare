// weXare's investors, shown at the foot of the front page, in this order. To add
// one, put its logo in ./backers/ and add an entry. Use the dark-on-light logo
// the investor publishes, unchanged, preferably SVG. Where it publishes only a
// light one, a dark copy is made and noted below.
//
// Sources: mozilla-ventures.svg and betaworks.svg come from mozilla.vc and
// betaworks.com. white-star-capital.svg is the dark wordmark Plastic Labs
// shows (whitestarcapital.com only serves a white PNG). offline-ventures.png
// is offline.vc's white wordmark with the letters turned #191919, the red dot
// kept and the margins trimmed.
import betaworks from './backers/betaworks.svg';
import mozillaVentures from './backers/mozilla-ventures.svg';
import offlineVentures from './backers/offline-ventures.png';
import whiteStarCapital from './backers/white-star-capital.svg';

export interface Backer {
  name: string;
  href: string;
  logo: string;
}

export const BACKERS: readonly Backer[] = [
  { name: 'Mozilla Ventures', href: 'https://mozilla.vc/', logo: mozillaVentures },
  { name: 'Betaworks', href: 'https://www.betaworks.com/', logo: betaworks },
  { name: 'White Star Capital', href: 'https://whitestarcapital.com/', logo: whiteStarCapital },
  { name: 'Offline Ventures', href: 'https://offline.vc/', logo: offlineVentures },
];
