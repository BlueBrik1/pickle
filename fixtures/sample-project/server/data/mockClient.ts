// Clearly labeled MOCK: in-memory fictional records, no network or database calls.
export const db = {
  from(table: string) {
    return {
      select: () => [{ id: 'demo-account', displayName: 'Demo person', status: 'active', table }],
      update: (value: unknown) => ({ id: 'demo-account', value, table }),
      insert: (value: unknown) => ({ id: 'demo-record', value, table }),
    };
  },
};
