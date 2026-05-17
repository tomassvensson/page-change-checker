import { formatResults } from '../../src/reporter.js';

describe('formatResults', () => {
  it('prints HTTP status, selector existence, and changed values', () => {
    const report = formatResults([
      {
        url: 'https://example.com',
        httpStatus: 200,
        error: null,
        loginNeeded: false,
        loginChecks: [],
        targets: [
          {
            cssPath: '.value',
            elementIndex: 0,
            compareMode: 'innerText',
            exists: true,
            matchCount: 1,
            changed: true,
            oldContent: 'old',
            newContent: 'new'
          }
        ]
      }
    ]);

    expect(report).toContain('HTTP status: 200');
    expect(report).toContain('Selector: .value [0]');
    expect(report).toContain('changed: yes');
    expect(report).toContain('old: old');
    expect(report).toContain('new: new');
  });

  it('prints login checks, unchanged content, and missing selectors', () => {
    const report = formatResults([
      {
        url: 'https://example.com/private',
        httpStatus: 401,
        error: 'Unauthorized',
        loginNeeded: true,
        loginChecks: [
          {
            cssPath: '.account',
            elementIndex: 0,
            compareMode: 'innerText',
            exists: false,
            matched: false,
            expectedContent: 'Account',
            actualContent: null,
            description: 'Account navigation'
          }
        ],
        targets: [
          {
            cssPath: '.unchanged',
            elementIndex: 0,
            compareMode: 'innerText',
            exists: true,
            matchCount: 1,
            changed: false,
            oldContent: 'same',
            newContent: 'same'
          },
          {
            cssPath: '.missing',
            elementIndex: 0,
            compareMode: 'innerHTML',
            exists: false,
            matchCount: 0,
            changed: null,
            oldContent: null,
            newContent: null
          }
        ]
      }
    ]);

    expect(report).toContain('Login necessary: yes');
    expect(report).toContain('Problem: Unauthorized');
    expect(report).toContain('after-login content: Account navigation');
    expect(report).toContain('changed: no');
    expect(report).toContain('selector did not match');
  });

  it('prints unavailable status, actual login content, and created baselines', () => {
    const report = formatResults([
      {
        url: 'https://example.com/new',
        httpStatus: null,
        error: null,
        loginNeeded: false,
        loginChecks: [
          {
            cssPath: '.account',
            elementIndex: 0,
            compareMode: 'innerText',
            exists: true,
            matched: true,
            expectedContent: null,
            actualContent: 'Signed in',
            description: null
          }
        ],
        targets: [
          {
            cssPath: '.new-value',
            elementIndex: 0,
            compareMode: 'innerHTML',
            exists: true,
            matchCount: 1,
            changed: null,
            oldContent: null,
            newContent: '<span>first baseline</span>'
          }
        ]
      }
    ]);

    expect(report).toContain('HTTP status: unavailable');
    expect(report).toContain('matched=yes');
    expect(report).toContain('actual: Signed in');
    expect(report).toContain('changed: baseline created');
    expect(report).toContain('new: <span>first baseline</span>');
  });
});
