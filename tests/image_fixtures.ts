// SPDX-License-Identifier: LGPL-3.0-only
import type { Cdp } from "./cdp.ts";
/** Browser-encoded original test art, not a fetched/personal image. */
export async function imageFixtures(page: Cdp, dir: string) {
  const encoded = await page.evaluate<Record<string, string>>(`(()=>{
    const c=document.createElement('canvas');c.width=240;c.height=136;
    const x=c.getContext('2d');x.fillStyle='#0284c7';x.fillRect(0,0,240,136);
    x.fillStyle='#ffffff';x.beginPath();x.arc(188,36,14,0,Math.PI*2);x.fill();
    x.fillStyle='#22262c';x.beginPath();x.moveTo(0,136);x.lineTo(80,45);x.lineTo(160,136);x.fill();
    x.fillStyle='#c1c7d0';x.beginPath();x.moveTo(90,136);x.lineTo(160,65);x.lineTo(240,136);x.fill();
    return Object.fromEntries(['png','jpeg','webp'].map(t=>[t,c.toDataURL('image/'+t).split(',')[1]]));
  })()`);
  encoded.gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const paths: Record<string, string> = {};
  for (const [format, data] of Object.entries(encoded)) {
    const path = `${dir}/received.${format}`;
    await Deno.writeFile(
      path,
      Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
    );
    paths[format] = path;
  }
  return paths;
}
export async function decodedImage(page: Cdp, id: number) {
  return await page.evaluate<{
    width: number;
    height: number;
    visible: boolean;
    bounded: boolean;
    src: string;
    caption: string;
    encrypted: boolean;
    alt: string;
    bounds: {
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
    };
  }>(
    `(async()=>{const a=document.querySelector('[data-message-id="${id}"]'),i=a?.querySelector('img');if(!i)return null;await i.decode();const r=i.getBoundingClientRect(),h=document.querySelector('.message-history').getBoundingClientRect();return {width:i.naturalWidth,height:i.naturalHeight,visible:r.width>0&&r.height>0&&r.bottom>Math.max(h.top,0)&&r.top<Math.min(h.bottom,innerHeight)&&r.right>0&&r.left<innerWidth,bounded:r.left>=h.left&&r.right<=h.right,src:i.getAttribute('src'),caption:a.querySelector('.message-text').textContent,encrypted:a.querySelector('.message-state').textContent.includes('Encrypted'),alt:i.alt,bounds:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}}})()`,
  );
}
