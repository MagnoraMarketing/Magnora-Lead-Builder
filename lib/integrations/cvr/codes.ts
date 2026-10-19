/**
 * Code lists for the CVR search form. Safe to import in the browser.
 *
 * Kommune codes are the official three-digit municipality codes
 * CVR stores in `beliggenhedsadresse.kommune.kommuneKode`.
 */

export interface KommuneOption {
  code: number;
  name: string;
}

export const KOMMUNER: readonly KommuneOption[] = [
  { code: 101, name: 'København' },
  { code: 147, name: 'Frederiksberg' },
  { code: 151, name: 'Ballerup' },
  { code: 153, name: 'Brøndby' },
  { code: 155, name: 'Dragør' },
  { code: 157, name: 'Gentofte' },
  { code: 159, name: 'Gladsaxe' },
  { code: 161, name: 'Glostrup' },
  { code: 163, name: 'Herlev' },
  { code: 165, name: 'Albertslund' },
  { code: 167, name: 'Hvidovre' },
  { code: 169, name: 'Høje-Taastrup' },
  { code: 173, name: 'Lyngby-Taarbæk' },
  { code: 175, name: 'Rødovre' },
  { code: 183, name: 'Ishøj' },
  { code: 185, name: 'Tårnby' },
  { code: 187, name: 'Vallensbæk' },
  { code: 190, name: 'Furesø' },
  { code: 201, name: 'Allerød' },
  { code: 210, name: 'Fredensborg' },
  { code: 217, name: 'Helsingør' },
  { code: 219, name: 'Hillerød' },
  { code: 223, name: 'Hørsholm' },
  { code: 230, name: 'Rudersdal' },
  { code: 240, name: 'Egedal' },
  { code: 250, name: 'Frederikssund' },
  { code: 253, name: 'Greve' },
  { code: 259, name: 'Køge' },
  { code: 260, name: 'Halsnæs' },
  { code: 265, name: 'Roskilde' },
  { code: 269, name: 'Solrød' },
  { code: 270, name: 'Gribskov' },
  { code: 306, name: 'Odsherred' },
  { code: 316, name: 'Holbæk' },
  { code: 320, name: 'Faxe' },
  { code: 326, name: 'Kalundborg' },
  { code: 329, name: 'Ringsted' },
  { code: 330, name: 'Slagelse' },
  { code: 336, name: 'Stevns' },
  { code: 340, name: 'Sorø' },
  { code: 350, name: 'Lejre' },
  { code: 360, name: 'Lolland' },
  { code: 370, name: 'Næstved' },
  { code: 376, name: 'Guldborgsund' },
  { code: 390, name: 'Vordingborg' },
  { code: 400, name: 'Bornholm' },
  { code: 410, name: 'Middelfart' },
  { code: 420, name: 'Assens' },
  { code: 430, name: 'Faaborg-Midtfyn' },
  { code: 440, name: 'Kerteminde' },
  { code: 450, name: 'Nyborg' },
  { code: 461, name: 'Odense' },
  { code: 479, name: 'Svendborg' },
  { code: 480, name: 'Nordfyns' },
  { code: 482, name: 'Langeland' },
  { code: 492, name: 'Ærø' },
  { code: 510, name: 'Haderslev' },
  { code: 530, name: 'Billund' },
  { code: 540, name: 'Sønderborg' },
  { code: 550, name: 'Tønder' },
  { code: 561, name: 'Esbjerg' },
  { code: 563, name: 'Fanø' },
  { code: 573, name: 'Varde' },
  { code: 575, name: 'Vejen' },
  { code: 580, name: 'Aabenraa' },
  { code: 607, name: 'Fredericia' },
  { code: 615, name: 'Horsens' },
  { code: 621, name: 'Kolding' },
  { code: 630, name: 'Vejle' },
  { code: 657, name: 'Herning' },
  { code: 661, name: 'Holstebro' },
  { code: 665, name: 'Lemvig' },
  { code: 671, name: 'Struer' },
  { code: 706, name: 'Syddjurs' },
  { code: 707, name: 'Norddjurs' },
  { code: 710, name: 'Favrskov' },
  { code: 727, name: 'Odder' },
  { code: 730, name: 'Randers' },
  { code: 740, name: 'Silkeborg' },
  { code: 741, name: 'Samsø' },
  { code: 746, name: 'Skanderborg' },
  { code: 751, name: 'Aarhus' },
  { code: 756, name: 'Ikast-Brande' },
  { code: 760, name: 'Ringkøbing-Skjern' },
  { code: 766, name: 'Hedensted' },
  { code: 773, name: 'Morsø' },
  { code: 779, name: 'Skive' },
  { code: 787, name: 'Thisted' },
  { code: 791, name: 'Viborg' },
  { code: 810, name: 'Brønderslev' },
  { code: 813, name: 'Frederikshavn' },
  { code: 820, name: 'Vesthimmerlands' },
  { code: 825, name: 'Læsø' },
  { code: 840, name: 'Rebild' },
  { code: 846, name: 'Mariagerfjord' },
  { code: 849, name: 'Jammerbugt' },
  { code: 851, name: 'Aalborg' },
  { code: 860, name: 'Hjørring' },
];

/** `virksomhedsform.virksomhedsformkode` for the common company forms. */
export const VIRKSOMHEDSFORMER = [
  { code: 80, label: 'ApS' },
  { code: 60, label: 'A/S' },
  { code: 10, label: 'Enkeltmandsvirksomhed' },
  { code: 30, label: 'I/S' },
  { code: 40, label: 'K/S' },
  { code: 70, label: 'P/S' },
] as const;

/** CVR's employee interval codes (`intervalKodeAntalAnsatte`). */
export const EMPLOYEE_BUCKETS = [
  { code: 'ANTAL_1_1', label: '1' },
  { code: 'ANTAL_2_4', label: '2–4' },
  { code: 'ANTAL_5_9', label: '5–9' },
  { code: 'ANTAL_10_19', label: '10–19' },
  { code: 'ANTAL_20_49', label: '20–49' },
  { code: 'ANTAL_50_99', label: '50–99' },
  { code: 'ANTAL_100_199', label: '100–199' },
  { code: 'ANTAL_200_499', label: '200–499' },
  { code: 'ANTAL_500_999', label: '500–999' },
  { code: 'ANTAL_1000_999999', label: '1000+' },
] as const;

export type EmployeeBucketCode = (typeof EMPLOYEE_BUCKETS)[number]['code'];

/** "ANTAL_10_19" → "10–19". Unknown shapes are returned unchanged. */
export function employeeIntervalLabel(code: string): string {
  const match = /^ANTAL_(\d+)_(\d+)$/i.exec(code.trim());
  if (!match) return code;
  const from = match[1] ?? '';
  const to = match[2] ?? '';
  if (Number(to) >= 999999) return `${from}+`;
  return from === to ? from : `${from}–${to}`;
}
