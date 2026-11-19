# Licence and credits: nebulae data

Applies to **every file in `frontend/data/objects/nebulae/`**:

- `manifest.json`;
- `tiles/*.json`, the nebula records;
- this file.

## Licence

These files are derived from OpenNGC: its objects, coordinates, sizes, magnitudes, names and identifiers were merged with the Sharpless catalogue (matched by identifier, a committed override table and position), given distances from Chornay & Walton 2021 and Russeil 2003, and converted to Space Maps' record format. The OpenNGC-derived values are licensed under the same CC BY-SA 4.0 licence; the exception is below.

The OpenNGC data, and the data derived from it, are licensed under **CC BY-SA 4.0**
(https://creativecommons.org/licenses/by-sa/4.0/).

Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC

## Values with other terms

The distances of the 59 planetary nebulae and their central-star identifiers come from Chornay & Walton 2021, who
derived them from Gaia EDR3. They are Gaia EDR3-derived values under **CC BY-NC 3.0 IGO**
(https://creativecommons.org/licenses/by-nc/3.0/igo/), with the credit "PN distances from Gaia EDR3: Credit: ESA/Gaia/DPAC". ESA's terms ask for
authorisation (data.licences@esa.int) before commercial use. They are **not** relicensed by CC BY-SA 4.0: each
value keeps the terms of its source.

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
- Russeil D., 2003, A&A 397, 133: Star-forming complexes and the spiral structure of our Galaxy (2003A&A...397..133R), doi:10.26093/cds/vizier.33970133, VizieR J/A+A/397/133

VizieR terms of use: https://cds.unistra.fr/vizier-org/licences_vizier.html

## Code

The code that builds these files (`backend/scripts/build_objects_nebulae.py`) and the rest of the repository are
under the MIT licence (see the repository `LICENSE`). Only the data files listed above carry the data terms described here.
