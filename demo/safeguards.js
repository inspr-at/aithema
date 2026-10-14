import { safeguardRedirect } from '@inspr/aithema-core';
export const start2PurposePolicy = {
  purpose: {
    de: 'Augmentoring hilft Unternehmen, individuelle Lösungen und Produkte zu entwickeln, und berät bei Geschäfts- und Prozessoptimierung; oft beides, und die Richtung kann sich im Gespräch ändern.',
    en: 'Augmentoring helps companies develop custom solutions and products, and advises on business and process optimization; often both, and the direction can change during the conversation.',
  },
  offTopicLimit: 3, outputCheck: true, redirect: safeguardRedirect,
};
