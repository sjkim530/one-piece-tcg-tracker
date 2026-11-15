# Forward signal records

The daily job saves one record per observed TCGCSV UTC date using prices and
product metadata available on that date. Older archives are used as inputs for
the rule but are never used to reconstruct missed signal days. Version 1 uses
the singles rules in market-analysis.js. Keep these thresholds fixed during
evaluation. Any future rule changes need a new version and separate results.

The public report compares Buy and Sell flags with unflagged singles of the
same TCGplayer card type and a similar price on the same date. Price groups
are powers of two in cents. At least five peers with exact forward quotes
are required per comparison. Retries keep the first record for a date.
