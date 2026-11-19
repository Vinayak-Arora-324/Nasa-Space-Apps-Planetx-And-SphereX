# Licence and credits: nea-exoplanets data

Applies to **every file in `backend/data/sources/nea-exoplanets/`**:

- `pscomppars-*.csv.gz`: the NASA Exoplanet Archive `pscomppars` table as downloaded;
- `gaia-dr2-dr3.csv.gz` and `gaia-positional.csv.gz`: ESA Gaia DR3 values (and the DR2 to DR3 neighbourhood table) fetched from the Gaia TAP service;
- `SOURCE.json`, the list of those inputs with their hashes, URLs and retrieval dates;
- this file.

## Which values are which

- The planet and star parameters from the NASA Exoplanet Archive come from the archive's `pscomppars` table. It
  asks that research using it carries this acknowledgement: This research has made use of the NASA Exoplanet Archive, which is operated by the California Institute of Technology, under contract with the National Aeronautics and Space Administration under the Exoplanet Exploration Program.
- The **Gaia DR3 values** (host-star positions, parallaxes and distances, G magnitudes and the identifiers matched
  to them) are ESA Gaia data, distributed under the **CC BY-NC 3.0 IGO** licence (https://creativecommons.org/licenses/by-nc/3.0/igo/).
  Credit: ESA/Gaia/DPAC. ESA's terms ask for authorisation (data.licences@esa.int) before commercial use.
  Gaia Collaboration, Vallenari et al. 2023 (Gaia DR3), A&A 674, A1. Each record's provenance says which of its values come from Gaia.

Each value keeps the terms of its source. Merging the two sources in one file does not relicense either of them.

## Code

The code that builds these files (`backend/scripts/build_objects_nea.py`) and the rest of the repository are
under the MIT licence (see the repository `LICENSE`).
