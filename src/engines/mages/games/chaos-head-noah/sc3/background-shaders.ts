/** Literal equations from shader.cpk sh030/031/032/037tlv_ps.
 * The ordering of tint, inversion, and luminance is part of the MAGES shader. */
const luminance = 'float l=(c.g*0.59+c.r*0.3)+c.b*0.11;';
export const backgroundShaders: Readonly<Record<number, string>> = {
  25: `vec4 shade(vec4 c,vec4 t){${luminance}return vec4(vec3(l),c.a)*t;}`,
  26: `vec4 shade(vec4 c,vec4 t){${luminance}vec3 rgb;if(l<0.5)rgb=(2.0*l)*t.rgb;else rgb=vec3(1.0)-(2.0*(1.0-l))*(vec3(1.0)-t.rgb);return vec4(rgb,c.a*t.a);}`,
  22: 'vec4 shade(vec4 c,vec4 t){c=c*t;return vec4(vec3(1.0)-c.rgb,c.a);}',
  27: `vec4 shade(vec4 c,vec4 t){${luminance}return vec4(vec3(1.0-l),c.a)*t;}`,
};
