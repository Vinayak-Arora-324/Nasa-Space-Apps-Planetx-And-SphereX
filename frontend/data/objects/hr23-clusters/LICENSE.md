# Licence and credits: hr23-clusters data

Applies to **every file in `frontend/data/objects/hr23-clusters/`**:

- `manifest.json`;
- `tiles/*.json`, the cluster records;
- this file.

## Terms

The values come from the Hunt & Reffert catalogue as served by VizieR (CDS Strasbourg), under VizieR's terms of use
(https://cds.unistra.fr/vizier-org/licences_vizier.html). Please cite:

- Hunt & Reffert 2024, A&A 686, A42 (2024A&A...686A..42H), doi:10.26093/cds/vizier.36860042; Hunt & Reffert 2023, A&A 673, A114 (2023A&A...673A.114H) for the cluster census and the quality cut

Hunt & Reffert derived the cluster positions, distances, sizes and memberships from Gaia DR3 data
(Credit: ESA/Gaia/DPAC). Nothing is relicensed here: the catalogue values keep VizieR's terms, and the underlying Gaia
data keep ESA's.

## Code

The code that builds these files (`backend/scripts/build_objects_hr23.py`) and the rest of the repository are
under the MIT licence (see the repository `LICENSE`).
