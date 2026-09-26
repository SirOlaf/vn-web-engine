/* Regenerates the synthetic 4,109-frame mono Vorbis fixture using libvorbisenc. */
#include <math.h>
#include <stdio.h>
#include <vorbis/vorbisenc.h>
static void page(FILE *out, ogg_page *page) {
  fwrite(page->header, 1, page->header_len, out);
  fwrite(page->body, 1, page->body_len, out);
}
int main(int argc, char **argv) {
  FILE *out = fopen(argv[1], "wb");
  vorbis_info vi; vorbis_comment vc; vorbis_dsp_state vd; vorbis_block vb;
  ogg_stream_state os; ogg_packet op, header, comments, setup; ogg_page og;
  vorbis_info_init(&vi);
  if (vorbis_encode_init_vbr(&vi, 1, 48000, 0.4f)) return 1;
  vorbis_comment_init(&vc);
  vorbis_analysis_init(&vd, &vi);
  vorbis_block_init(&vd, &vb);
  ogg_stream_init(&os, 1729);
  vorbis_analysis_headerout(&vd, &vc, &header, &comments, &setup);
  ogg_stream_packetin(&os, &header);
  ogg_stream_packetin(&os, &comments);
  ogg_stream_packetin(&os, &setup);
  while (ogg_stream_flush(&os, &og)) page(out, &og);
  for (int at = 0; at <= 4109;) {
    int n = at < 4109 ? (4109 - at < 1024 ? 4109 - at : 1024) : 0;
    float **pcm = vorbis_analysis_buffer(&vd, n ? n : 1);
    for (int i = 0; i < n; i++)
      pcm[0][i] = 0.25 * cos(2 * 3.141592653589793 * 440 * (at + i) / 48000.0);
    vorbis_analysis_wrote(&vd, n);
    while (vorbis_analysis_blockout(&vd, &vb) == 1) {
      vorbis_analysis(&vb, NULL);
      vorbis_bitrate_addblock(&vb);
      while (vorbis_bitrate_flushpacket(&vd, &op)) {
        ogg_stream_packetin(&os, &op);
        while (ogg_stream_pageout(&os, &og)) page(out, &og);
      }
    }
    if (!n) break;
    at += n;
  }
  ogg_stream_clear(&os); vorbis_block_clear(&vb); vorbis_dsp_clear(&vd);
  vorbis_comment_clear(&vc); vorbis_info_clear(&vi); fclose(out);
  return 0;
}
