export const getProjectId = () => location.pathname.split("/").pop();

/**
 * @returns { string }
 */
export const accessToken = () => JSON.parse(localStorage.getItem("recoil-persist")).accessToken;

/**
 * @param { Blob } blob
 * @returns { Promise<string> }
 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}
