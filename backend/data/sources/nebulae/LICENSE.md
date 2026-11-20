# Licence and credits: nebulae data

Applies to **every file in `backend/data/sources/nebulae/`**:

- the gzipped input snapshots (`*.gz`): OpenNGC `NGC.csv` and `addendum.csv` exactly as published at commit `36cb178a0f69dba8bfc03a99c10512831edf1c6b`, and the six VizieR tables (Sharpless, Chornay & Walton, Russeil, Shen et al. `table2` and `tablea1`) without their `#` header lines;
- `SOURCE.json`, the list of those inputs with their hashes, URLs and retrieval dates;
- `sh2_ongc_overrides.json` and `shen_overrides.json`, the hand-written merge and Shen link override tables;
- this file.

## Licence

The OpenNGC files are unmodified copies. The six VizieR tables are unmodified copies too, redistributed with the credit below under VizieR's terms of use (https://cds.unistra.fr/vizier-org/licences_vizier.html); CC BY-SA 4.0 does not relicense them.

The OpenNGC data, and the data derived from it, are licensed under **CC BY-SA 4.0**
(https://creativecommons.org/licenses/by-sa/4.0/).

Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC

## Values with other terms

Two sets of values are Gaia-derived. (1) The distances of the 59 planetary nebulae and their central-star
identifiers come from Chornay & Walton 2021, who derived them from Gaia EDR3 parallaxes. (2) The HII-region distances
taken from Shen et al. 2025 whose `src` says "Gaia DR3" (their Group I, II and III rows without a maser remark, some
of them values from Mendez-Delgado et al. 2022 based on Gaia DR3) are Bailer-Jones et al. 2021 distances of exciting
stars, from Gaia DR3. Both are under **CC BY-NC 3.0 IGO** (https://creativecommons.org/licenses/by-nc/3.0/igo/), with the credit "PN distances
(Chornay & Walton 2021, Gaia EDR3) and HII-region distances (Shen et al. 2025, Gaia DR3): Credit: ESA/Gaia/DPAC". ESA's terms
ask for authorisation (data.licences@esa.int) before commercial use. They are **not** relicensed by CC BY-SA 4.0:
each value keeps the terms of its source.

The rows of Shen et al. 2025 that adopt a VLBI maser parallax (their `src` says "VLBI maser parallax", never
"Gaia") are **not** Gaia values: they come from the literature through VizieR (terms: https://cds.unistra.fr/vizier-org/licences_vizier.html), and so do
the Russeil 2003 distances.

OpenNGC is at https://github.com/mattiaverga/OpenNGC, release v20260501, commit `36cb178a0f69dba8bfc03a99c10512831edf1c6b`. Changes made here: the rows of the
types PN, HII, EmN, RfN, Neb, SNR, Cl+N and DrkN were selected, merged with the Sharpless catalogue, given
distances and re-encoded as JSON records (see `docs/object-framework.md`, section 17).

## OpenNGC acknowledgements

OpenNGC has been built by merging data from:

- NASA/IPAC Extragalactic Database, http://ned.ipac.caltech.edu/
  This research has made use of the NASA/IPAC Extragalactic Database (NED) which is operated by the Jet Propulsion
  Laboratory, California Institute of Technology, under contract with the National Aeronautics and Space
  Administration.
- HyperLEDA database, http://leda.univ-lyon1.fr
  We acknowledge the usage of the HyperLeda database (http://leda.univ-lyon1.fr)
- SIMBAD Astronomical Database, http://simbad.u-strasbg.fr/simbad/
  This research has made use of the SIMBAD database, operated at CDS, Strasbourg, France
- HEASARC High Energy Astrophysics Science Archive Research Center, http://heasarc.gsfc.nasa.gov/
  We used several databases from HEASARC such as messier, mwsc, lbn, plnebulae, lmcextobj and smcclustrs.
- Harold Corwin's NGC/IC Positions and Notes, http://haroldcorwin.net/ngcic/index.html

Some common names are taken from internet sources like Wikipedia.

## Other catalogues (via VizieR, CDS Strasbourg)

- Sharpless S., 1959, ApJS 4, 257: A Catalogue of H II Regions (1959ApJS....4..257S), VizieR VII/20
- Chornay N. & Walton N. A., 2021, A&A 656, A110: One star, two star, red star, blue star: an updated planetary nebula central star distance catalogue from Gaia EDR3 (2021A&A...656A.110C), doi:10.26093/cds/vizier.36560110, VizieR J/A+A/656/A110
- Shen X.-J., Hou L.-G., Liu Z. & Gao Z.-M., 2025, A&A 696, A67: Parallax-based distances to Galactic HII regions: nearby spiral structure (arXiv:2503.01551, 2025A&A...696A..67S), doi:10.1051/0004-6361/202452712, VizieR J/A+A/696/A67
- Russeil D., 2003, A&A 397, 133: Star-forming complexes and the spiral structure of our Galaxy (2003A&A...397..133R), doi:10.26093/cds/vizier.33970133, VizieR J/A+A/397/133

VizieR terms of use: https://cds.unistra.fr/vizier-org/licences_vizier.html

## Code

The code that builds these files (`backend/scripts/build_objects_nebulae.py`) and the rest of the repository are
under the MIT licence (see the repository `LICENSE`). Only the data files listed above carry the data terms described here.
