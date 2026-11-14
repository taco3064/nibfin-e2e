// Maintained diagnostic codes cross the API; native errors may contain secrets.
export class FixtureError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export const fixtureErrorCode = error => error instanceof FixtureError ?
  error.code : 'FIXTURE_PROVIDER_UNAVAILABLE';
