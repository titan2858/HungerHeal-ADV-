// Every photograph the site uses, in one place.
//
// Swapping in different photography is a change to this file only - nothing
// imports an image path directly. Each entry carries its own alt text, because
// an image without a description is invisible to a screen reader and the
// description belongs next to the choice of image, not scattered through the
// pages.
import heroDonation from '../assets/img/hero-donation.jpg';
import connection from '../assets/img/connection.jpg';
import freshProduce from '../assets/img/fresh-produce.jpg';
import produceCrate from '../assets/img/produce-crate.jpg';
import kitchen from '../assets/img/kitchen.jpg';

export const IMAGES = {
  hero: {
    src: heroDonation,
    alt: 'Volunteers unloading crates of donated food from the back of a truck',
  },
  connection: {
    src: connection,
    alt: 'Two hands reaching towards each other',
  },
  produce: {
    src: freshProduce,
    alt: 'Fresh vegetables, herbs and eggs laid out on a wooden board',
  },
  crate: {
    src: produceCrate,
    alt: 'A wooden crate of freshly picked carrots at a market stall',
  },
  kitchen: {
    src: kitchen,
    alt: 'Three people cooking a meal together in a home kitchen',
  },
};
