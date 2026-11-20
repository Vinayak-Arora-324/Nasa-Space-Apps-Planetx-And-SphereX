# Licence and credits: hr23-clusters data

Applies to **every file in `backend/data/sources/hr23-clusters/`**:

- `clusters-hr24-*.csv.gz`: the Hunt & Reffert 2024 cluster table from VizieR (J/A+A/686/A42), columns selected;
- `members-hr24-*.csv.gz`: the Hunt & Reffert 2024 members table (table 2, `J/A+A/686/A42/members`) from VizieR, for the clusters within 500 pc, columns ID, GaiaDR3, Prob, inrt;
- `SOURCE.json`, the inputs' hashes, URLs and retrieval dates;
- this file.

## Terms

The values come from the Hunt & Reffert catalogue as served by VizieR (CDS Strasbourg), under VizieR's terms of use
(https://cds.unistra.fr/vizier-org/licences_vizier.html). Please cite:

- Hunt & Reffert 2024, A&A 686, A42 (2024A&A...686A..42H), doi:10.26093/cds/vizier.36860042; Hunt & Reffert 2023, A&A 673, A114 (2023A&A...673A.114H) for the cluster census and the quality cut

Hunt & Reffert derived the cluster positions, distances, sizes and memberships from Gaia DR3 data
(Credit: ESA/Gaia/DPAC). Nothing is relicensed here: the catalogue values keep VizieR's terms, and the underlying Gaia
data keep ESA's.

## The members folder

The `members/` folder of the dataset (`frontend/data/objects/hr23-clusters/members/`) and the members snapshot hold
Gaia-derived values: the Hunt & Reffert 2024 members table (table 2, `J/A+A/686/A42/members`) lists, for each cluster
within 500 pc, its member stars by Gaia DR3 source id with a membership probability and a
tidal-radius flag. Credit: ESA/Gaia/DPAC. The Gaia data are available under CC BY-NC 3.0 IGO (non-commercial use),
and the table keeps VizieR's terms of use (https://cds.unistra.fr/vizier-org/licences_vizier.html), as for the clusters table.

## Code

The code that builds these files (`backend/scripts/build_objects_hr23.py`) and the rest of the repository are
under the MIT licence (see the repository `LICENSE`).
