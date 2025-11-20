// client/tailwind.config.cjs
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#f5fbff',
          100: '#e6f3ff',
          200: '#bfe0ff',
          300: '#99ccff',
          400: '#66aafa',
          500: '#3388f0', // primary brand color
          600: '#2c6fd1',
          700: '#2355a8',
          800: '#1a3a7a',
          900: '#0f274d'
        },
        accent: '#FF7A59'
      },
      keyframes: {
        float: {
          '0%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-6px)' },
          '100%': { transform: 'translateY(0px)' }
        },
        pop: {
          '0%': { transform: 'scale(0.96)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' }
        },
        pulseNotify: {
          '0%': { transform: 'scale(1)', boxShadow: '0 0 0 0 rgba(255,122,89,0.6)' },
          '70%': { transform: 'scale(1.03)', boxShadow: '0 0 0 10px rgba(255,122,89,0)' },
          '100%': { transform: 'scale(1)', boxShadow: '0 0 0 0 rgba(255,122,89,0)' }
        }
      },
      animation: {
        float: 'float 3.6s ease-in-out infinite',
        pop: 'pop 220ms cubic-bezier(.2,.9,.3,1) forwards',
        pulseNotify: 'pulseNotify 1.2s ease-out'
      }
    }
  },
  plugins: []
}
