/* Decodes the first Theora stream of an Ogg file from stdin with libtheoradec and writes
 * every output frame (full frame size, Y then Cb then Cr, rows top-down) to stdout.
 * stderr receives one line of stream info. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ogg/ogg.h>
#include <theora/theoradec.h>

int main(int argc, char **argv) {
  int limit = argc > 1 ? atoi(argv[1]) : 0x7fffffff;
  ogg_sync_state oy; ogg_page og; ogg_packet op; ogg_stream_state os;
  th_info ti; th_comment tc; th_setup_info *ts = NULL; th_dec_ctx *td = NULL;
  int have_stream = 0, headers = 0, frames = 0;
  ogg_sync_init(&oy); th_info_init(&ti); th_comment_init(&tc);
  for (;;) {
    char *buf = ogg_sync_buffer(&oy, 65536);
    size_t n = fread(buf, 1, 65536, stdin);
    ogg_sync_wrote(&oy, (long)n);
    while (ogg_sync_pageout(&oy, &og) == 1) {
      if (!have_stream) {
        if (!ogg_page_bos(&og)) continue;
        ogg_stream_init(&os, ogg_page_serialno(&og));
        ogg_stream_pagein(&os, &og);
        if (ogg_stream_packetout(&os, &op) != 1 || th_decode_headerin(&ti, &tc, &ts, &op) <= 0) {
          ogg_stream_clear(&os);
          continue;
        }
        have_stream = 1;
      } else if (ogg_page_serialno(&og) == os.serialno) ogg_stream_pagein(&os, &og);
      else continue;
      while (ogg_stream_packetout(&os, &op) == 1) {
        if (!td) {
          int r = th_decode_headerin(&ti, &tc, &ts, &op);
          if (r > 0) continue;
          if (r < 0) { fprintf(stderr, "header error %d\n", r); return 1; }
          td = th_decode_alloc(&ti, ts);
          fprintf(stderr, "frame %ux%u pic %ux%u+%u+%u fmt %d fps %u/%u\n", ti.frame_width,
                  ti.frame_height, ti.pic_width, ti.pic_height, ti.pic_x, ti.pic_y,
                  ti.pixel_fmt, ti.fps_numerator, ti.fps_denominator);
        }
        ogg_int64_t gp;
        int r = th_decode_packetin(td, &op, &gp);
        if (r < 0) { fprintf(stderr, "packet error %d at frame %d\n", r, frames); return 1; }
        th_ycbcr_buffer yuv;
        th_decode_ycbcr_out(td, yuv);
        for (int p = 0; p < 3; p++)
          for (int y = 0; y < yuv[p].height; y++)
            fwrite(yuv[p].data + (ptrdiff_t)y * yuv[p].stride, 1, yuv[p].width, stdout);
        if (++frames >= limit) { fprintf(stderr, "frames %d\n", frames); return 0; }
      }
    }
    if (n == 0) break;
  }
  fprintf(stderr, "frames %d\n", frames);
  return 0;
}
