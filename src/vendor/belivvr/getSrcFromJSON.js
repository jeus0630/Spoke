/**
 * @param {string} src
 * @return {Promise<string>}
 */
export default async function getSrcFromJSON(src) {
  const data = await fetch(src).then(response => response.json());
  return data.src;
}
