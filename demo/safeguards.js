import { de } from '@inspr/aithema-ui/i18n/de';
import { en } from '@inspr/aithema-ui/i18n/en';
export const start2PurposePolicy = {
  purpose: {
    de: 'Augmentoring hilft Unternehmen, individuelle Lösungen und Produkte zu entwickeln, und berät bei Geschäfts- und Prozessoptimierung; oft beides, und die Richtung kann sich im Gespräch ändern.',
    en: 'Augmentoring helps companies develop custom solutions and products, and advises on business and process optimization; often both, and the direction can change during the conversation.',
  },
  offTopicLimit: 3, outputCheck: true, redirect: (locale, turn) => ({ de, en })[locale].purposeRedirects[turn - 1],
  directionQuestion: { de: de.purposeDirection, en: en.purposeDirection },
};
