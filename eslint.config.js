/* eslint-disable import-x/no-default-export */
import prettier from 'eslint-config-prettier';

import apify from '@apify/eslint-config/js.js';

export default [{ ignores: ['**/dist'] }, ...apify, prettier];
