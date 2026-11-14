import type { Query } from './types';
export const initialBrowserState = (query: Query) => ({
  search: query.search ?? '',
  where: query.where,
  showAdvanced: false,
  orderBy: query.orderBy ?? [],
  groupBy: query.groupBy ?? [],
  page: 1,
  layout: 'grid',
  jobId: '',
  scroll: 0,
});
